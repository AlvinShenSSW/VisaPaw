import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createFetcher, FetchError } from '../electron/fetcher.ts';

const FIX = join(process.cwd(), 'tests', 'fixtures');
const countriesJson = readFileSync(join(FIX, 'termstore-countries.json'), 'utf8');
const cricosJson = readFileSync(join(FIX, 'termstore-cricos.json'), 'utf8');
const notlistedJson = readFileSync(join(FIX, 'checklist-type-chn-notlisted.json'), 'utf8');
const selectedJson = readFileSync(join(FIX, 'checklist-type-chn-selected.json'), 'utf8');
const pageHtml = gunzipSync(readFileSync(join(FIX, 'evidentiary-tool.html.gz'))).toString('utf8');

const ok = (body: string, init: ResponseInit = {}) => new Response(body, { status: 200, ...init });
const tmp = () => mkdtempSync(join(tmpdir(), 'visapaw-fetcher-'));

const DAY = 24 * 3600 * 1000;

describe('fetchTerms（Termstore + 7 天缓存）', () => {
  it('解析 fixture 全量列表并落缓存；7 天内复用缓存', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok(countriesJson));
    let clock = 1_000_000;
    const f = createFetcher({ cacheDir: tmp(), fetchImpl, now: () => clock });
    const items = await f.fetchTerms('countries');
    expect(items.length).toBe(237);
    expect(items.every((i) => typeof i.key === 'string' && typeof i.value === 'string')).toBe(true);
    clock += 6 * DAY;
    await f.fetchTerms('countries');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('缓存过期（>7 天）后重抓；缓存损坏自愈', async () => {
    // Response body 只能消费一次——每次调用都要新实例
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(ok(cricosJson)));
    let clock = 1_000_000;
    const dir = tmp();
    const f = createFetcher({ cacheDir: dir, fetchImpl, now: () => clock });
    await f.fetchTerms('cricos');
    clock += 8 * DAY;
    const items = await f.fetchTerms('cricos');
    expect(items.length).toBe(1669);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    writeFileSync(join(dir, 'terms-cricos.json'), '{broken');
    await f.fetchTerms('cricos');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('并发同 kind 调用合流为一次请求（Kimi 终审 P2）', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(ok(countriesJson)));
    const f = createFetcher({ cacheDir: tmp(), fetchImpl });
    const [a, b] = await Promise.all([f.fetchTerms('countries'), f.fetchTerms('countries')]);
    expect(a.length).toBe(237);
    expect(b.length).toBe(237);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('Termstore 空列表 → structure 错误且不写缓存（Codex 外门 P2）', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve(ok('{"d":{"success":true,"data":[]}}')))
      .mockImplementationOnce(() => Promise.resolve(ok(countriesJson)));
    const f = createFetcher({ cacheDir: tmp(), fetchImpl });
    await expect(f.fetchTerms('countries')).rejects.toMatchObject({ kind: 'structure' });
    // 空结果未入缓存 → 下一次调用重抓成功
    expect((await f.fetchTerms('countries')).length).toBe(237);
  });

  it('body 读取中断 → network 而非 structure（Codex 外门 P2）', async () => {
    const res = new Response('x');
    vi.spyOn(res, 'text').mockRejectedValue(new Error('aborted mid-body'));
    const f = createFetcher({ cacheDir: tmp(), fetchImpl: vi.fn().mockResolvedValue(res) });
    await expect(f.fetchTerms('countries')).rejects.toMatchObject({ kind: 'network' });
  });

  it('Termstore 响应形状不符 → structure 错误', async () => {
    const f = createFetcher({
      cacheDir: tmp(),
      fetchImpl: vi.fn().mockResolvedValue(ok('{"d":{"success":false}}')),
    });
    await expect(f.fetchTerms('countries')).rejects.toMatchObject({ kind: 'structure' });
  });
});

describe('fetchChecklistType（判定接口，实测 fixture 双路径）', () => {
  it('CHN + 未定院校 → Streamlined（实测路径）', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok(notlistedJson));
    const f = createFetcher({ cacheDir: tmp(), fetchImpl });
    const result = await f.fetchChecklistType({
      countryPassport: 'CHN',
      provider: 'NotListed',
      cricosCode: ' ',
      studentTypeCode: '01',
    });
    expect(result).toBe('Streamlined');
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.studentEvidenceStudyTypeCode).toBe('01');
  });

  it('CHN + 选定院校（provider=Key、cricosCode=Value，2026-07-19 实测）→ Streamlined', async () => {
    const f = createFetcher({ cacheDir: tmp(), fetchImpl: vi.fn().mockResolvedValue(ok(selectedJson)) });
    const result = await f.fetchChecklistType({
      countryPassport: 'CHN',
      provider: 'The University of Melbourne (UniMelb)',
      cricosCode: '00116K',
      studentTypeCode: '01',
    });
    expect(result).toBe('Streamlined');
  });

  it('studentResult 非法值 → structure 错误', async () => {
    const f = createFetcher({
      cacheDir: tmp(),
      fetchImpl: vi.fn().mockResolvedValue(ok('{"d":{"success":true,"data":[{"studentResult":"Weird"}]}}')),
    });
    await expect(
      f.fetchChecklistType({ countryPassport: 'CHN', provider: 'NotListed', cricosCode: ' ', studentTypeCode: '01' })
    ).rejects.toMatchObject({ kind: 'structure' });
  });
});

describe('错误分类（类型驱动，供 #13 三态 UI）', () => {
  const params = { countryPassport: 'CHN', provider: 'NotListed', cricosCode: ' ', studentTypeCode: '01' } as const;

  it('HTTP 403 → forbidden（与网络错误可区分）', async () => {
    const f = createFetcher({ cacheDir: tmp(), fetchImpl: vi.fn().mockResolvedValue(ok('denied', { status: 403 })) });
    const err = await f.fetchChecklistType(params).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect((err as FetchError).kind).toBe('forbidden');
  });

  it('HTTP 500 → network（带 status）', async () => {
    const f = createFetcher({ cacheDir: tmp(), fetchImpl: vi.fn().mockResolvedValue(ok('oops', { status: 500 })) });
    await expect(f.fetchChecklistType(params)).rejects.toMatchObject({ kind: 'network', status: 500 });
  });

  it('fetch 拒绝（断网/超时 abort）→ network', async () => {
    const f = createFetcher({ cacheDir: tmp(), fetchImpl: vi.fn().mockRejectedValue(new TypeError('fetch failed')) });
    await expect(f.fetchChecklistType(params)).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('fetchChecklistPage + 结构指纹', () => {
  it('真实快照通过指纹校验并返回抓取时间（UTC）', async () => {
    const f = createFetcher({
      cacheDir: tmp(),
      fetchImpl: vi.fn().mockResolvedValue(ok(pageHtml)),
      now: () => Date.UTC(2026, 6, 19, 4, 0, 0),
    });
    const page = await f.fetchChecklistPage();
    expect(page.html).toContain('id="Regular"');
    expect(page.fetchedAt).toBe('2026-07-19T04:00:00.000Z');
  });

  it('三清单 div 缺一 → structure 错误（触发 #13 WebView 降级）', async () => {
    const broken = pageHtml.replace('id="Undetermined"', 'id="Renamed"');
    const f = createFetcher({ cacheDir: tmp(), fetchImpl: vi.fn().mockResolvedValue(ok(broken)) });
    await expect(f.fetchChecklistPage()).rejects.toMatchObject({ kind: 'structure' });
  });

  it('verifyStructure 可独立校验（启动时探测用）', () => {
    const f = createFetcher({ cacheDir: tmp() });
    expect(f.verifyStructure(pageHtml)).toBe(true);
    expect(f.verifyStructure('<html></html>')).toBe(false);
  });
});
