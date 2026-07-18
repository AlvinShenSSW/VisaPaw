/*
 * 官网数据抓取层（main process 专用）——AGENTS 关键技术事实的落地：
 * Termstore 下拉（7 天缓存）、清单类型判定、清单页实时抓取、结构指纹校验。
 * 红线：仅本机直连，无任何代理配置项；单用户低频、串行、无自动重试。
 * 网络与时钟可注入——单测 100% fixture 回放。
 */

import fs from 'node:fs';
import path from 'node:path';

const BASE = 'https://immi.homeaffairs.gov.au';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TERMS_CACHE_MS = 7 * 24 * 3600 * 1000;
const DEFAULT_TIMEOUT_MS = 20_000;

export type FetchErrorKind = 'network' | 'forbidden' | 'structure';

export class FetchError extends Error {
  readonly kind: FetchErrorKind;
  readonly status?: number;
  constructor(kind: FetchErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'FetchError';
    this.kind = kind;
    this.status = status;
  }
}

export interface TermItem {
  key: string;
  value: string;
}

export type TermKind = 'countries' | 'cricos';

export type ChecklistType = 'Regular' | 'Streamlined' | 'Undetermined';

export interface ChecklistTypeParams {
  countryPassport: string;
  /** 选定院校 = Termstore Key（校名）；未定 = 'NotListed'（2026-07-19 实测，SPEC §3） */
  provider: string;
  /** 选定院校 = Termstore Value（CRICOS 码）；未定 = ' ' */
  cricosCode: string;
  /** '01'–'05'（SPEC §3 学生类型码） */
  studentTypeCode: string;
}

export interface ChecklistPage {
  html: string;
  /** 抓取时间，UTC ISO（展示层转本地时区，SPEC §7） */
  fetchedAt: string;
}

export interface FetcherDeps {
  /** Termstore 缓存目录（main 传 userData 子目录） */
  cacheDir: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export interface Fetcher {
  fetchTerms(kind: TermKind): Promise<TermItem[]>;
  fetchChecklistType(params: ChecklistTypeParams): Promise<ChecklistType>;
  fetchChecklistPage(): Promise<ChecklistPage>;
  verifyStructure(html: string): boolean;
}

const TERM_SETS: Record<TermKind, string> = {
  countries: 'CountriesOfPassport',
  cricos: 'CRICOS',
};

const CHECKLIST_TYPES: readonly string[] = ['Regular', 'Streamlined', 'Undetermined'];

// 官网实际标签形态：`<div class="accordion" id="Regular" …>`（fixture 实测，id 前有其他属性）——
// 属性感知匹配而非裸子串，避免 JS 字符串/无关属性误命中（Kimi 终审 P2）
const FINGERPRINT_DIV_IDS = ['Regular', 'Streamlined', 'Undetermined'] as const;
// 值整体锚定 + 双引号风格兼容——`id="RegularV2"` 不得误命中（Kimi 终审 P2）
const fingerprintPattern = (id: string): RegExp =>
  new RegExp(`<div\\b[^>]*\\bid=["']${id}["'](?=[\\s/>])`);

interface TermsCacheFile {
  fetchedAt: number;
  items: TermItem[];
}

function verifyStructure(html: string): boolean {
  return FINGERPRINT_DIV_IDS.every((id) => fingerprintPattern(id).test(html));
}

export function createFetcher(deps: FetcherDeps): Fetcher {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // 并发同 kind 请求合流——防缓存竞态与重复官网请求（Kimi 终审 P2）
  const inFlightTerms = new Map<TermKind, Promise<TermItem[]>>();
  // 官网请求全局串行——任一时刻至多一个在途请求（AGENTS：禁止批量并发；Kimi 终审 P2）
  let requestChain: Promise<unknown> = Promise.resolve();
  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = requestChain.then(fn, fn);
    requestChain = run.catch(() => undefined);
    return run;
  }

  const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  async function request(pathname: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await serialized(() =>
        fetchImpl(BASE + pathname, {
          ...init,
          signal: AbortSignal.timeout(timeoutMs),
        })
      );
    } catch (e) {
      throw new FetchError('network', `官网请求失败（网络不可达或超时）：${errMsg(e)}`);
    }
    if (res.status === 403) {
      throw new FetchError('forbidden', '官网拒绝访问（403）——请确认使用住宅网络、未开启 VPN/数据中心代理', 403);
    }
    if (!res.ok) {
      throw new FetchError('network', `官网返回异常状态：HTTP ${res.status}`, res.status);
    }
    return res;
  }

  /** 读 body：传输中断/超时 → network；只有读取成功后的解析失败才算 structure（Codex 外门 P2） */
  async function readBody(res: Response): Promise<string> {
    try {
      return await res.text();
    } catch (e) {
      throw new FetchError('network', `官网响应读取中断：${errMsg(e)}`);
    }
  }

  async function postJson(pathname: string, body: unknown): Promise<unknown> {
    const res = await request(pathname, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await readBody(res);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new FetchError('structure', '官网接口返回了非 JSON 内容——页面结构可能已变化');
    }
  }

  /** 校验 `{d:{success:true,data:[…]}}` 包络并返回 data 数组，形状不符抛 structure */
  function unwrapEnvelope(payload: unknown, what: string): unknown[] {
    const d = (payload as { d?: { success?: boolean; data?: unknown } } | null)?.d;
    if (!d || d.success !== true || !Array.isArray(d.data)) {
      throw new FetchError('structure', `${what} 响应结构不符（缺少 d.success/d.data）——官网可能已改版`);
    }
    return d.data;
  }

  function cacheFile(kind: TermKind): string {
    return path.join(deps.cacheDir, `terms-${kind}.json`);
  }

  function readTermsCache(kind: TermKind): TermItem[] | null {
    try {
      const raw = JSON.parse(fs.readFileSync(cacheFile(kind), 'utf8')) as TermsCacheFile;
      if (
        typeof raw.fetchedAt === 'number' &&
        Array.isArray(raw.items) &&
        raw.items.length > 0 &&
        raw.items.every((i) => typeof i?.key === 'string' && typeof i?.value === 'string') &&
        raw.fetchedAt <= now() && // 未来时间戳（时钟回拨/篡改）不算有效缓存
        now() - raw.fetchedAt < TERMS_CACHE_MS
      ) {
        return raw.items;
      }
    } catch {
      /* 缓存缺失/损坏 → 重抓自愈 */
    }
    return null;
  }

  return {
    async fetchTerms(kind) {
      const cached = readTermsCache(kind);
      if (cached) return cached;
      const inFlight = inFlightTerms.get(kind);
      if (inFlight) return inFlight;
      const task = (async () => {
        const payload = await postJson('/_layouts/15/api/Termstore.aspx/GetTermsByProperty', {
          groupName: 'IMMI',
          termSetName: TERM_SETS[kind],
          propertyName: 'Code',
        });
        const data = unwrapEnvelope(payload, 'Termstore');
        // 两个 term set 均应为全量列表——空结果视为结构异常，绝不写缓存（Codex 外门 P2）
        if (data.length === 0) {
          throw new FetchError('structure', `Termstore（${TERM_SETS[kind]}）返回空列表——官网可能已改版`);
        }
        const items: TermItem[] = data.map((row) => {
          const r = row as { Key?: unknown; Value?: unknown };
          if (typeof r.Key !== 'string' || typeof r.Value !== 'string') {
            throw new FetchError('structure', 'Termstore 条目缺少 Key/Value 字段——官网可能已改版');
          }
          return { key: r.Key, value: r.Value };
        });
        fs.mkdirSync(deps.cacheDir, { recursive: true });
        const tmp = `${cacheFile(kind)}.tmp`;
        // 创建即 0600，无 chmod 窗口期（Kimi 终审 P2）
        fs.writeFileSync(tmp, JSON.stringify({ fetchedAt: now(), items } satisfies TermsCacheFile), {
          mode: 0o600,
        });
        fs.renameSync(tmp, cacheFile(kind));
        return items;
      })();
      inFlightTerms.set(kind, task);
      try {
        return await task;
      } finally {
        inFlightTerms.delete(kind);
      }
    },

    async fetchChecklistType(params) {
      const payload = await postJson('/_layouts/15/api/ESB.aspx/GetStudentDocumentChecklistType', {
        countryPassport: params.countryPassport,
        provider: params.provider,
        cricosCode: params.cricosCode,
        studentEvidenceStudyTypeCode: params.studentTypeCode,
      });
      const data = unwrapEnvelope(payload, '清单类型判定接口');
      const result = (data[0] as { studentResult?: unknown } | undefined)?.studentResult;
      if (typeof result !== 'string' || !CHECKLIST_TYPES.includes(result)) {
        throw new FetchError('structure', `清单类型判定返回未知值：${String(result)}——官网可能已改版`);
      }
      return result as ChecklistType;
    },

    async fetchChecklistPage() {
      const res = await request('/visas/web-evidentiary-tool', {
        method: 'GET',
        headers: { 'User-Agent': UA },
      });
      const html = await readBody(res);
      if (!verifyStructure(html)) {
        throw new FetchError('structure', '清单页缺少 Regular/Streamlined/Undetermined 结构——官网已改版，请使用 WebView 手动模式');
      }
      return { html, fetchedAt: new Date(now()).toISOString() };
    },

    verifyStructure,
  };
}
