/*
 * 生成日志管道（#15）——pipeline 各阶段结构化日志，按「运行」一文件存本机，
 * 不含任何个人信息（参数摘要仅 国籍·CRICOS·类型码，红线 2）。
 * 级别/阶段字面量与导出文本格式对齐 mockups/04 日志窗口示例。
 */

import fs from 'node:fs';
import path from 'node:path';
import type {
  LogEntry,
  LogLevel,
  LogStage,
  RunLog,
  RunParams,
  RunSummary,
} from '../common/types.ts';
import type { AiEvent } from './ai/orchestrator.ts';
import type { ClassifierEvent } from './classifier.ts';

const PROVIDER_LABEL: Record<string, string> = {
  claude: 'Claude',
  openai: 'ChatGPT',
  mimo: 'MiMo',
};

export interface RunHandle {
  readonly id: string;
  log(level: LogLevel, stage: LogStage, message: string, durationMs?: number): void;
  finish(status: 'success' | 'error', extra?: { checklistType?: string }): void;
}

export interface LogStore {
  startRun(params: RunParams): RunHandle;
  listRuns(): RunSummary[];
  getRun(id: string): RunLog | null;
  /** mockup 同构文本行导出；运行不存在返回 null */
  exportRun(id: string): string | null;
  clear(): void;
}

export interface LogStoreOptions {
  now?: () => number;
  /** 按 startedAt 保留最近 N 次运行（默认 50） */
  maxRuns?: number;
}

export function createLogStore(dir: string, opts: LogStoreOptions = {}): LogStore {
  const now = opts.now ?? Date.now;
  const maxRuns = opts.maxRuns ?? 50;
  let seq = 0;

  function fileOf(id: string): string {
    return path.join(dir, `${id}.json`);
  }

  function writeRun(run: RunLog): void {
    // 日志是尽力而为——磁盘满/权限等 IO 失败绝不能炸掉生成主流程（Kimi 终审 P2）
    try {
      fs.mkdirSync(dir, { recursive: true });
      const target = fileOf(run.summary.id);
      const tmp = `${target}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(run, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, target);
    } catch (e) {
      console.warn(`[visapaw] 日志写入失败（忽略）：${(e as Error).message}`);
    }
  }

  function readRunFile(file: string): RunLog | null {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as RunLog;
      const p = raw?.summary?.params;
      if (
        raw?.summary?.id &&
        Array.isArray(raw.entries) &&
        typeof p?.country === 'string' &&
        typeof p?.cricosCode === 'string' &&
        typeof p?.studentTypeCode === 'string'
      ) {
        return raw;
      }
    } catch {
      /* 损坏文件跳过 */
    }
    return null;
  }

  function allRuns(): RunLog[] {
    return listRunFiles()
      .map(readRunFile)
      .filter((r): r is RunLog => r !== null)
      .sort((a, b) => b.summary.startedAt - a.summary.startedAt);
  }

  function listRunFiles(includeTmp = false): string[] {
    try {
      return fs
        .readdirSync(dir)
        .filter(
          (f) =>
            f.startsWith('run-') && (f.endsWith('.json') || (includeTmp && f.endsWith('.json.tmp')))
        );
    } catch {
      return [];
    }
  }

  function prune(): void {
    const runs = allRuns();
    for (const stale of runs.slice(maxRuns)) {
      try {
        fs.rmSync(fileOf(stale.summary.id));
      } catch {
        /* 已不存在则忽略 */
      }
    }
    // 损坏文件与中断遗留的 .tmp 对用户不可见也不可用——一并清除（Codex P2 / Kimi minor）
    const validIds = new Set(runs.map((r) => `${r.summary.id}.json`));
    for (const f of listRunFiles(true)) {
      if (!validIds.has(f)) {
        try {
          fs.rmSync(path.join(dir, f));
        } catch {
          /* 忽略 */
        }
      }
    }
  }

  return {
    startRun(params) {
      const startedAt = now();
      seq += 1;
      const id = `run-${startedAt}-${seq}`;
      // 白名单重建——结构化类型允许多余属性经变量流入，直接落盘会持久化
      // 表单对象上的任何额外字段（如姓名），违反无个人信息保证（Codex 外门 P1）
      const safeParams: RunParams = {
        country: params.country,
        cricosCode: params.cricosCode,
        studentTypeCode: params.studentTypeCode,
      };
      const run: RunLog = {
        summary: { id, startedAt, params: safeParams, status: 'running' },
        entries: [],
      };
      writeRun(run);
      prune();
      return {
        id,
        log(level, stage, message, durationMs) {
          run.entries.push({ ts: now(), level, stage, message, durationMs });
          writeRun(run);
        },
        finish(status, extra) {
          run.summary.status = status;
          run.summary.totalMs = now() - startedAt;
          if (extra?.checklistType) run.summary.checklistType = extra.checklistType;
          // 导出文本要有明确的终态行（Kimi 终审 minor）
          run.entries.push({
            ts: now(),
            level: status === 'success' ? 'ok' : 'err',
            stage: status === 'success' ? '完成' : '失败',
            message:
              status === 'success'
                ? `清单已生成 · 总耗时 ${(run.summary.totalMs / 1000).toFixed(1)}s`
                : '生成失败——详见上方错误条目',
          });
          writeRun(run);
        },
      };
    },

    listRuns() {
      return allRuns().map((r) => r.summary);
    },

    getRun(id) {
      return allRuns().find((r) => r.summary.id === id) ?? null;
    },

    exportRun(id) {
      const run = allRuns().find((r) => r.summary.id === id);
      if (!run) return null;
      const head = [
        `VisaPaw 生成日志 · ${formatTs(run.summary.startedAt)}`,
        `参数：${run.summary.params.country} · ${run.summary.params.cricosCode} · 学生类型 ${run.summary.params.studentTypeCode}`,
        `状态：${run.summary.status}${run.summary.totalMs !== undefined ? ` · 总耗时 ${(run.summary.totalMs / 1000).toFixed(1)}s` : ''}`,
        '',
      ];
      const lines = run.entries.map((e) => {
        const dur = e.durationMs !== undefined ? `（${(e.durationMs / 1000).toFixed(1)}s）` : '';
        return `${formatClock(e.ts)} [${e.level}|${e.stage}] ${e.message}${dur}`;
      });
      return [...head, ...lines].join('\n');
    },

    clear() {
      // 枚举原始文件而非解析成功的运行——损坏文件与 .tmp 也必须清除（Codex P2 / Kimi minor）
      for (const f of listRunFiles(true)) {
        try {
          fs.rmSync(path.join(dir, f));
        } catch {
          /* 忽略 */
        }
      }
    },
  };
}

/* ------------------------- #8 / #6 事件 → 日志条目桥 ------------------------- */

/** AiEvent → 日志条目（fallback 行含前后 provider 与错误原因——mockups/04 示例语义） */
export function aiEventToLog(e: AiEvent): Omit<LogEntry, 'ts'> | null {
  const label = (p: string): string => PROVIDER_LABEL[p] ?? p;
  switch (e.type) {
    case 'skip':
      return {
        level: 'info',
        stage: '翻译',
        message: `${label(e.provider)} 跳过（${e.reason === 'no-key' ? '未配置 API key' : '未启用'}）`,
      };
    case 'retry':
      return {
        level: 'warn',
        stage: '翻译',
        message: `${label(e.provider)} · ${e.model} 结构化输出解析失败，重试一次`,
      };
    case 'fallback':
      return {
        level: e.errorKind === 'quota' ? 'err' : 'warn',
        stage: '翻译',
        message: `fallback：${label(e.provider)} · ${e.model}（${e.errorKind}：${e.message}）→ ${
          e.next ? label(e.next) : '无下一顺位'
        }`,
      };
    case 'success':
      return {
        level: 'ok',
        stage: '翻译',
        message: `完成 · 实际 provider：${label(e.provider)} · ${e.model}`,
      };
  }
}

/** ClassifierEvent → 日志条目（映射告警必须入日志——issue 验收） */
export function classifierEventToLog(e: ClassifierEvent): Omit<LogEntry, 'ts'> {
  switch (e.type) {
    case 'mapping-outdated':
      return {
        level: 'warn',
        stage: '分类',
        message: `映射表未命中新章节「${e.section}」→ 触发「映射表需更新」告警`,
      };
    case 'auto-classified':
      return {
        level: 'info',
        stage: '分类',
        message: `「${e.section}」由 AI 兜底归类为 ${e.category}（已标注 · ${PROVIDER_LABEL[e.meta.provider] ?? e.meta.provider} · ${e.meta.model}）`,
      };
    case 'manual-pending':
      return {
        level: 'warn',
        stage: '分类',
        message: `「${e.section}」归入待人工归类（${e.reason}）`,
      };
  }
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
