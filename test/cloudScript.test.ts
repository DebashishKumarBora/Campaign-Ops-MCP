import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { desktopConfigPath, newSetupCode, parseJsonc, unlinkDesktop, writeConfig } from '../scripts/cloud.js';

const BASE = `// comment with "quotes" and a // inside
{
  "name": "campaign-ops", /* block */
  "kv_namespaces": [{ "binding": "OAUTH_KV" }],
  "url": "https://example.com/a//b",
}
`;

test('Wrangler settings with comments are read correctly', () => {
  const cfg = parseJsonc(BASE) as { name: string; url: string };
  assert.equal(cfg.name, 'campaign-ops');
  assert.equal(cfg.url, 'https://example.com/a//b');
});

test('remaking the settings keeps the OAuth store that Wrangler created', () => {
  assert.equal(writeConfig(BASE, ''), BASE);
  const deployed = BASE.replace('{ "binding": "OAUTH_KV" }', '{ "binding": "OAUTH_KV", "id": "0123456789abcdef0123456789abcdef" }');
  const again = writeConfig(BASE, deployed);
  assert.match(again, /"id": "0123456789abcdef0123456789abcdef"/);
  const real = fs.readFileSync(path.join(process.cwd(), 'cloud', 'wrangler.base.jsonc'), 'utf8');
  assert.match(writeConfig(real, deployed), /"binding": "OAUTH_KV", "id": "0123456789abcdef0123456789abcdef"/);
});

test('setup codes are easy to type and match what the server checks', () => {
  const now = 1_800_000_000_000;
  const { code, secret } = newSetupCode(now);
  assert.match(code, /^[A-HJ-NP-TV-Z2-9]{4}-[A-HJ-NP-TV-Z2-9]{4}-[A-HJ-NP-TV-Z2-9]{4}$/);
  const s = JSON.parse(secret) as { hash: string; expiresAt: number; epoch: string };
  assert.equal(s.expiresAt, now + 3_600_000);
  assert.ok(s.epoch.length >= 12);
  // The server uppercases the typed code and drops anything that is not a letter or digit.
  const typed = code.toLowerCase().replace(/-/g, ' ').toUpperCase().replace(/[^A-Z0-9]/g, '');
  assert.equal(crypto.createHash('sha256').update(`campaign-ops-setup:${typed}`).digest('base64url'), s.hash);
  assert.notEqual(newSetupCode(now).code, code);
});

test('unlinking Claude Desktop removes only the local Campaign Ops entry and keeps a backup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cops-desktop-'));
  try {
    const file = path.join(dir, 'claude_desktop_config.json');
    const before = {
      mcpServers: {
        'campaign-ops': { command: 'node', args: ['C:\\Users\\debas\\campaign-ops-mcp\\dist\\src\\index.js'] },
        'ops-renamed': { command: 'node', args: ['C:\\Users\\debas\\campaign-ops-mcp\\dist\\src\\index.js'] },
        filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users\\debas\\Desktop'] },
      },
      preferences: { theme: 'dark' },
    };
    fs.writeFileSync(file, JSON.stringify(before));
    const r = unlinkDesktop(file);
    assert.deepEqual(r.removed.sort(), ['campaign-ops', 'ops-renamed']);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(after.mcpServers), ['filesystem']);
    assert.deepEqual(after.preferences, { theme: 'dark' });
    assert.deepEqual(JSON.parse(fs.readFileSync(r.backup!, 'utf8')), before);
    assert.deepEqual(unlinkDesktop(file).removed, []);
    assert.deepEqual(unlinkDesktop(path.join(dir, 'missing.json')).removed, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude Desktop settings are found on Windows, macOS and Linux', () => {
  assert.equal(desktopConfigPath('win32', { APPDATA: 'C:\\Users\\debas\\AppData\\Roaming' }, 'C:\\Users\\debas'), path.join('C:\\Users\\debas\\AppData\\Roaming', 'Claude', 'claude_desktop_config.json'));
  assert.equal(desktopConfigPath('darwin', {}, '/Users/deb'), path.join('/Users/deb', 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
  assert.equal(desktopConfigPath('linux', {}, '/home/deb'), path.join('/home/deb', '.config', 'Claude', 'claude_desktop_config.json'));
});
