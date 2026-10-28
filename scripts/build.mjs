import { build, context } from 'esbuild';
import { build as buildWebview } from 'vite';
import { mkdir } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await mkdir('artifacts', { recursive: true });
const options = { bundle: true, platform: 'node', format: 'cjs', target: 'node20', sourcemap: true, external: ['vscode', 'node:sqlite'], logLevel: 'info' };
const builds = [
  { ...options, entryPoints: ['packages/extension/src/extension.ts'], outfile: 'dist/extension.cjs' },
  { ...options, entryPoints: ['packages/runner/src/sqlite-runner.ts'], outfile: 'dist/sqlite-runner.cjs', target: 'node22' },
  { ...options, entryPoints: ['packages/extension/src/sql-worker.ts'], outfile: 'dist/sql-worker.cjs' },
];
if (process.argv.includes('--runner-only')) {
  await build(builds[1]);
} else if (process.argv.includes('--watch')) {
  for (const options of builds) await (await context(options)).watch();
  await buildWebview({ build: { watch: {} } });
} else {
  for (const options of builds) await build(options);
  await buildWebview();
}
