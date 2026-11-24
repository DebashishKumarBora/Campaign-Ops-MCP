// Builds the browser demo: bundles the real engine into web/site/engine.js.
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shim = (name) => path.join(root, 'web', 'shims', `${name}.js`);

await build({
  entryPoints: [path.join(root, 'web', 'entry.ts')],
  outfile: path.join(root, 'web', 'site', 'engine.js'),
  bundle: true,
  format: 'iife',
  globalName: 'CampaignOps',
  platform: 'browser',
  target: ['es2020'],
  minify: true,
  legalComments: 'none',
  banner: { js: '/* Campaign Ops engine, browser build. Source: https://github.com/debashishkumarbora/campaign-ops-mcp (MIT) */' },
  alias: { 'node:fs': shim('fs'), 'node:path': shim('path'), 'node:crypto': shim('crypto') },
  define: { SharedArrayBuffer: 'ArrayBuffer', 'process.pid': '1' },
  logLevel: 'info',
});
