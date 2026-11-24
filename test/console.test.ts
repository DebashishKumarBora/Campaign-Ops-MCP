import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { startConsole } from '../src/console/server.js';
import { projectRoot } from '../src/util/root.js';
import { ACCOUNT, AGENT, REASON, budgetChange, makeRig } from './helpers.js';

const TOKEN = 'console-test-key-0123456789';

function request(port: number, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers: { Host: `127.0.0.1:${port}`, ...(opts.headers ?? {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

test('approval console security and actions', async () => {
  const rig = makeRig();
  const handle = await startConsole({ engine: rig.engine, backend: rig.backend, token: TOKEN, port: 0, uiDir: path.join(projectRoot(), 'console-ui'), version: 'test' });
  const port = handle.port;
  try {
    const health = await request(port, { path: '/health' });
    assert.equal(health.status, 200);

    const page = await request(port, { path: '/' });
    assert.equal(page.status, 200);
    assert.match(page.headers['content-security-policy'] as string, /frame-ancestors 'none'/);
    assert.equal(page.headers['x-frame-options'], 'DENY');

    assert.equal((await request(port, { path: '/api/state' })).status, 401, 'no key');
    assert.equal((await request(port, { path: '/api/state', headers: { 'X-Console-Token': 'wrong-key-wrong-key-123' } })).status, 401, 'wrong key');
    assert.equal((await request(port, { path: '/api/state', headers: { Host: 'evil.example:80', 'X-Console-Token': TOKEN } })).status, 421, 'DNS rebinding blocked');

    const state = await request(port, { path: '/api/state', headers: { 'X-Console-Token': TOKEN } });
    assert.equal(state.status, 200);
    assert.ok(!state.body.includes(TOKEN), 'the key is never echoed back');

    const p = await rig.engine.propose({ accountId: ACCOUNT, change: budgetChange(50), reason: REASON, requestedBy: AGENT });
    const approvePath = `/api/proposals/${p.id}/approve`;

    const crossSite = await request(port, { method: 'POST', path: approvePath, headers: { 'X-Console-Token': TOKEN, 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
    assert.equal(crossSite.status, 403, 'cross-origin POST refused');

    const formPost = await request(port, { method: 'POST', path: approvePath, headers: { 'X-Console-Token': TOKEN, 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(formPost.status, 415, 'non-JSON POST refused');

    const ok = await request(port, { method: 'POST', path: approvePath, headers: { 'X-Console-Token': TOKEN, 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` }, body: JSON.stringify({ note: 'Looks right' }) });
    assert.equal(ok.status, 200);
    const approved = await rig.engine.getProposal(p.id);
    assert.equal(approved?.status, 'approved');
    assert.equal(approved?.approval?.channel, 'console');
    assert.equal(approved?.approval?.note, 'Looks right');

    const again = await request(port, { method: 'POST', path: approvePath, headers: { 'X-Console-Token': TOKEN, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(again.status, 400, 'cannot approve twice');

    const kill = await request(port, { method: 'POST', path: '/api/kill-switch', headers: { 'X-Console-Token': TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ on: true }) });
    assert.equal(kill.status, 200);
    assert.equal(rig.engine.killSwitchState().on, true);
  } finally {
    await handle.close();
    rig.cleanup();
  }
});
