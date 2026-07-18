/*
 * 把 Electron main + preload（TypeScript）打包为 CJS。仅打包本仓库代码，
 * node_modules 全部 external、运行时解析。（复用 BookingPro desktop/ 构建链）
 */

import esbuild from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
};

const entries = [
  { entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.cjs' },
  { entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs' },
];

const watch = process.argv.includes('--watch');
for (const entry of entries) {
  const ctx = await esbuild.context({ ...common, ...entry });
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}
if (watch) console.log('[esbuild] watching electron main/preload…');
