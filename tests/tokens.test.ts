import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const stylesDir = join(process.cwd(), 'renderer', 'styles');
const tokens = readFileSync(join(stylesDir, 'tokens.css'), 'utf8');

describe('设计 token 单一来源（mockups 逐字对齐）', () => {
  it('tokens.css 含 mockup 浅色与深色关键取值', () => {
    for (const v of ['#2E9BDF', '#1E86C9', '#EAF5FD', '#E9EDF2', '#F5F7FA', '#FFFFFF']) {
      expect(tokens).toContain(v);
    }
    for (const v of ['#4FB0F0', '#6BBEF5', '#1C3A52', '#17191D', '#232629', '#2C3034']) {
      expect(tokens).toContain(v);
    }
    expect(tokens).toMatch(/prefers-color-scheme:\s*dark/);
    expect(tokens).toMatch(/-apple-system/);
    expect(tokens).toMatch(/PingFang SC/);
  });

  it('tokens.css 之外的样式文件不得硬编码色值（验收：token 不散落）', () => {
    const offenders: string[] = [];
    for (const f of readdirSync(stylesDir)) {
      if (f === 'tokens.css' || !f.endsWith('.css')) continue;
      const css = readFileSync(join(stylesDir, f), 'utf8');
      if (/#[0-9a-fA-F]{3,8}\b/.test(css)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
