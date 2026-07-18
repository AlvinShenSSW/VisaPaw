/*
 * AI provider API key 存储：Electron safeStorage（macOS Keychain 派生密钥）加密，
 * 按 provider 命名空间隔离（AGENTS Provider 层约定），不落盘明文。
 * key 永不进入 renderer——status 只含 saved 与展示用前缀（#12 决议）。
 * 加密接口注入以便单测（main.ts 注入 safeStorage）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { PROVIDER_IDS, type ProviderId } from './settings-store.ts';

const assertProviderId: (v: unknown) => asserts v is ProviderId = (v) => {
  if (!(PROVIDER_IDS as readonly string[]).includes(v as string)) {
    throw new Error(`未知 provider：${String(v)}`);
  }
};

export interface SafeCrypto {
  isAvailable(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(blob: Buffer): string;
}

export interface KeyStatus {
  saved: boolean;
  /** 展示用前缀（如 `sk-ant-…`），仅取 key 的非敏感头部标识，不由 key 全文派生掩码 */
  prefix: string | null;
}

export interface CredentialStore {
  setKey(provider: ProviderId, key: string): void;
  getKey(provider: ProviderId): string | null;
  deleteKey(provider: ProviderId): void;
  getStatus(): Record<ProviderId, KeyStatus>;
}

type Vault = Partial<Record<ProviderId, string>>;

/** 取 key 的展示前缀：第一段连字符标识 + 省略号（sk-ant-… / mimo-…），不含 key 本体 */
function displayPrefix(key: string): string {
  const m = /^([A-Za-z0-9]+(?:-[A-Za-z]+)*)-/.exec(key);
  return (m ? m[1] + '-' : key.slice(0, 4)) + '…';
}

export function createCredentialStore(filePath: string, crypto: SafeCrypto): CredentialStore {
  function read(): Vault {
    if (!fs.existsSync(filePath)) return {};
    if (!crypto.isAvailable()) {
      console.warn('[visapaw] 凭据文件存在但 OS 安全存储不可用——无法解密');
      return {};
    }
    try {
      return JSON.parse(crypto.decrypt(fs.readFileSync(filePath))) as Vault;
    } catch (e) {
      console.warn(`[visapaw] 凭据无法读取/解密：${(e as Error).message}`);
      return {};
    }
  }
  function write(vault: Vault): void {
    if (!crypto.isAvailable()) {
      throw new Error('OS 安全存储不可用——无法保存 API key');
    }
    // 临时文件（0600）+ rename，写中崩溃不会留下截断的 blob
    const tmp = `${filePath}.tmp`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmp, crypto.encrypt(JSON.stringify(vault)));
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, filePath);
  }
  return {
    setKey(provider, key) {
      assertProviderId(provider);
      if (typeof key !== 'string' || key.trim() === '') {
        throw new Error('API key 不能为空');
      }
      write({ ...read(), [provider]: key.trim() });
    },
    getKey(provider) {
      assertProviderId(provider);
      return read()[provider] ?? null;
    },
    deleteKey(provider) {
      assertProviderId(provider);
      const vault = read();
      delete vault[provider];
      write(vault);
    },
    getStatus() {
      const vault = read();
      const status = {} as Record<ProviderId, KeyStatus>;
      for (const id of PROVIDER_IDS) {
        const key = vault[id];
        status[id] = key ? { saved: true, prefix: displayPrefix(key) } : { saved: false, prefix: null };
      }
      return status;
    },
  };
}
