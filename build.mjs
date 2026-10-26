// Build the host half. The client half is hand-written JS loaded by the web
// module loader (`window.__ModuleLoader__.load`), so it needs no build step.
import { build } from 'esbuild'

await build({
  entryPoints: ['src/host/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  tsconfig: 'tsconfig.json',
  // Type-only imports plus any future host packages: the harness provides them.
  external: ['@deepseek-ai/*'],
})
