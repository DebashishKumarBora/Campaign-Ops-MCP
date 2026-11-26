// Builds the two browser demos from the real code:
//   web/site/engine.js   the engine alone, for the guided demo page (web/site)
//   web/app/             the full Campaign Ops app (console-ui) on the same engine, Autopilot and console API
// Only the file system, path and hashing libraries are swapped for in-memory versions (web/shims).
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shim = (name) => path.join(root, 'web', 'shims', `${name}.js`);
const shared = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  minify: true,
  legalComments: 'none',
  alias: { 'node:fs': shim('fs'), 'node:path': shim('path'), 'node:crypto': shim('crypto') },
  define: { SharedArrayBuffer: 'ArrayBuffer', 'process.pid': '1' },
  logLevel: 'info',
};

await build({
  ...shared,
  entryPoints: [path.join(root, 'web', 'entry.ts')],
  outfile: path.join(root, 'web', 'site', 'engine.js'),
  globalName: 'CampaignOps',
  banner: { js: '/* Campaign Ops engine, browser build. Source: https://github.com/debashishkumarbora/campaign-ops-mcp (MIT) */' },
});

await build({
  ...shared,
  entryPoints: [path.join(root, 'web', 'app-entry.ts')],
  outfile: path.join(root, 'web', 'app', 'demo-engine.js'),
  globalName: 'CampaignOpsDemo',
  banner: { js: '/* Campaign Ops live demo: the engine, Autopilot and console API, browser build. Source: https://github.com/debashishkumarbora/campaign-ops-mcp (MIT) */' },
});

// The app itself is copied from console-ui unchanged, except that its font is found next to the page.
const ui = path.join(root, 'console-ui');
const out = path.join(root, 'web', 'app');
const copy = (from, to = from) => {
  fs.mkdirSync(path.dirname(path.join(out, to)), { recursive: true });
  fs.copyFileSync(path.join(ui, from), path.join(out, to));
};
copy('app.js');
copy('theme.js');
fs.writeFileSync(path.join(out, 'app.css'), fs.readFileSync(path.join(ui, 'app.css'), 'utf8').replaceAll("url('/fonts/", "url('fonts/"));
for (const f of fs.readdirSync(path.join(ui, 'fonts'))) copy(path.join('fonts', f));
for (const f of ['icon-192.png', 'apple-touch-icon.png']) copy(path.join('icons', f));
console.log('web/app ready: open web/app/index.html through any static server.');
