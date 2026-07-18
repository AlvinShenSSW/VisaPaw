import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCredentialStore, type SafeCrypto } from '../electron/credential-store.ts';

/** 可逆假加密（前缀 + base64），足以验证「落盘非明文」与命名空间语义 */
const fakeCrypto: SafeCrypto = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from('ENC:' + Buffer.from(s).toString('base64')),
  decrypt: (b) => Buffer.from(b.toString().slice(4), 'base64').toString(),
};

describe('createCredentialStore（按 provider 命名空间）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'visapaw-creds-'));

  it('set/get 按 provider 隔离；重开实例可读', () => {
    const f = join(dir, 'credentials.bin');
    const store = createCredentialStore(f, fakeCrypto);
    store.setKey('claude', 'sk-ant-test-123');
    store.setKey('mimo', 'mimo-key-456');
    expect(store.getKey('claude')).toBe('sk-ant-test-123');
    expect(store.getKey('openai')).toBeNull();
    expect(createCredentialStore(f, fakeCrypto).getKey('mimo')).toBe('mimo-key-456');
  });

  it('落盘内容不含 key 明文', () => {
    const f = join(dir, 'noplain.bin');
    createCredentialStore(f, fakeCrypto).setKey('claude', 'sk-ant-SECRET');
    expect(readFileSync(f).toString()).not.toContain('sk-ant-SECRET');
  });

  it('status 只暴露 saved 与前缀，不含 key 本体（#12 决议）', () => {
    const f = join(dir, 'status.bin');
    const store = createCredentialStore(f, fakeCrypto);
    store.setKey('claude', 'sk-ant-abcdef123456');
    const st = store.getStatus();
    expect(st.providers.claude).toEqual({ saved: true, prefix: 'sk-ant-…' });
    expect(st.providers.openai).toEqual({ saved: false, prefix: null });
    expect(st.error).toBeNull();
    expect(JSON.stringify(st)).not.toContain('abcdef');
  });

  it('无法识别格式的 key 前缀为 null，绝不截取 key 本体（Kimi 终审 P2）', () => {
    const f = join(dir, 'noprefix.bin');
    const store = createCredentialStore(f, fakeCrypto);
    store.setKey('mimo', 'ZmFrZXJhd2tleXdpdGhvdXRkYXNo');
    const st = store.getStatus();
    expect(st.providers.mimo.saved).toBe(true);
    expect(st.providers.mimo.prefix).toBeNull();
    expect(JSON.stringify(st)).not.toContain('ZmFr');
  });

  it('文件存在但解密失败 → status.error 显性化，而非误报未保存（Kimi 终审 P2）', () => {
    const f = join(dir, 'decrypt-fail.bin');
    createCredentialStore(f, fakeCrypto).setKey('claude', 'sk-ant-x');
    const broken: SafeCrypto = {
      ...fakeCrypto,
      decrypt: () => {
        throw new Error('keychain denied');
      },
    };
    const st = createCredentialStore(f, broken).getStatus();
    expect(st.providers.claude.saved).toBe(false);
    expect(st.error).toMatch(/无法读取|解密/);
  });

  it('删除 key 后 status 归位', () => {
    const f = join(dir, 'del.bin');
    const store = createCredentialStore(f, fakeCrypto);
    store.setKey('openai', 'sk-openai-xyz');
    store.deleteKey('openai');
    expect(store.getKey('openai')).toBeNull();
    expect(store.getStatus().providers.openai.saved).toBe(false);
  });

  it('未知 provider id 被拒绝（IPC 面防御，CTO 自审）', () => {
    const f = join(dir, 'badid.bin');
    const store = createCredentialStore(f, fakeCrypto);
    // @ts-expect-error 故意传入非法 id 验证运行时防御
    expect(() => store.setKey('bogus', 'k')).toThrow(/未知 provider/);
    // @ts-expect-error 同上——非法 id 的运行时防御
    expect(() => store.getKey('bogus')).toThrow(/未知 provider/);
  });

  it('OS 安全存储不可用时 set 抛错、get 返回 null', () => {
    const dead: SafeCrypto = { ...fakeCrypto, isAvailable: () => false };
    const f = join(dir, 'dead.bin');
    const store = createCredentialStore(f, dead);
    expect(() => store.setKey('claude', 'x')).toThrow();
    expect(store.getKey('claude')).toBeNull();
  });
});
