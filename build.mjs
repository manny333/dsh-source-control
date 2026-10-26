// Build the host half. The client half is hand-written JS loaded by the web
// module loader (`window.__ModuleLoader__.load`), so it needs no build step.
import { build } from 'esbuild'

const shared = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  tsconfig: 'tsconfig.json',
  // Type-only imports plus any future host packages: the harness provides them.
  external: ['@deepseek-ai/*'],
}

// The plugin entry, shipped as one file.
await build({ ...shared, entryPoints: ['src/host/index.ts'], outfile: 'lib/index.js' })

// Modules the tests import directly, so a unit test exercises the code that
// ships instead of a copy. `routes.js` inlines `git.js`; both are small.
await build({ ...shared, entryPoints: ['src/host/git.ts', 'src/host/routes.ts', 'src/host/commit-message.ts'], outdir: 'lib' })
