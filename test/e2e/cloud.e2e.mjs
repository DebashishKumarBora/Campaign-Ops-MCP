// End-to-end check of Campaign Ops in the cloud, run entirely on this computer:
//   the real Worker and Durable Object (wrangler dev, the same runtime as Cloudflare),
//   a fake Google Ads API with a live account, a fake push service that decrypts
//   every notification, and Chromium with a virtual passkey (WebAuthn over CDP).
//
// It walks the whole story: move history from a laptop, set up the first passkey,
// connect an AI app through OAuth with passkey consent, propose over MCP, get the
// phone notification, approve with a passkey, apply, open a live change window,
// undo, check every signature, run the morning watch, add and remove a passkey.
//
// Run: npm run test:cloud   (needs Playwright with Chromium: npx playwright install chromium)

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { LIVE_D, LIVE_NAME, SETUP_CODE, loadPlaywright, sleep, startCloud, waitFor } from './harness.mjs';

const { chromium } = loadPlaywright();

const results = [];
let failures = 0;
let currentPage;
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push(`  ✓ ${name} (${Date.now() - t0} ms)`);
    console.log(`✓ ${name}`);
  } catch (e) {
    failures++;
    results.push(`  ✕ ${name}: ${e.message}`);
    console.error(`✕ ${name}\n${e.stack}`);
    if (currentPage) {
      const text = await currentPage.evaluate(() => document.body.innerText).catch(() => '');
      console.error(`Page at failure: ${currentPage.url()}\n${text.slice(0, 800)}`);
    }
    throw e;
  }
}

// ---------- main ----------

const procs = [];
let browser;
let cloud;

try {
  await step('the Worker starts in wrangler dev', async () => {
    cloud = await startCloud();
    assert.deepEqual(await (await fetch(`${cloud.BASE}/mode`)).json(), { mode: 'cloud' });
  });
  const { BASE, IMPORT_TOKEN, push, subscription, google, history } = cloud;

  const post = (p, body, headers = {}) => fetch(`${BASE}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE, ...headers }, body: JSON.stringify(body) });

  await step('laptop history moves to the cloud once, with its hash chain checked', async () => {
    const wrong = await post('/admin/import', history, { Authorization: 'Bearer wrong' });
    assert.equal(wrong.status, 401);
    const r = await post('/admin/import', history, { Authorization: `Bearer ${IMPORT_TOKEN}` });
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.equal(body.entries, history.entries);
    assert.equal(body.proposals, 1);
    const again = await post('/admin/import', history, { Authorization: `Bearer ${IMPORT_TOKEN}` });
    assert.equal(again.status, 409);
  });

  await step('the console API refuses anyone without a passkey session', async () => {
    assert.equal((await fetch(`${BASE}/api/state`)).status, 401);
    const s = await (await fetch(`${BASE}/auth/session`)).json();
    assert.deepEqual(s, { mode: 'cloud', signedIn: false, hasPasskeys: false, setupOpen: true });
    const cross = await fetch(`${BASE}/auth/setup/options`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
    assert.equal(cross.status, 403);
  });

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  currentPage = page;
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Refused requests are part of this check (wrong code, missing passkey), so failed loads are expected; script errors are not.
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const authenticator = (opts = {}) => cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, ...opts } });
  let phone = (await authenticator()).authenticatorId;

  const toast = (text) => page.locator('.toast', { hasText: text }).first().waitFor({ timeout: 15_000 });
  const inPage = async (p, method = 'GET', body) => {
    if (!page.url().startsWith(BASE)) await page.goto(BASE);
    return page.evaluate(async ([p, method, body]) => {
      const res = await fetch(p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    }, [p, method, body]);
  };

  await step('a wrong setup code is refused', async () => {
    await page.goto(BASE);
    await page.locator('#setup-form').waitFor();
    await page.fill('#setup-code', 'AAAA-BBBB-CCCC');
    await page.fill('#setup-name', 'Deb');
    await page.fill('#setup-device', 'iPhone');
    await page.click('#setup-form button[type="submit"]');
    await page.locator('.gate .error', { hasText: 'not right' }).waitFor();
  });

  await step('the first passkey is created with the setup code and signs the owner in', async () => {
    await page.fill('#setup-code', SETUP_CODE.toLowerCase());
    await page.click('#setup-form button[type="submit"]');
    await toast('Passkey created on iPhone');
    await page.locator('.hero-title').waitFor();
    const creds = (await cdp.send('WebAuthn.getCredentials', { authenticatorId: phone })).credentials;
    assert.equal(creds.length, 1);
    assert.equal(creds[0].isResidentCredential, true);
    const s = await (await page.evaluate(() => fetch('/auth/session').then((r) => r.json())));
    assert.equal(s.signedIn, true);
    assert.equal(s.setupOpen, false, 'the setup code works once');
    const cookies = await context.cookies(BASE);
    const c = cookies.find((x) => x.name === '__Host-cops-session');
    assert.ok(c && c.httpOnly && c.sameSite === 'Strict', 'session cookie is HttpOnly and SameSite=Strict');
  });

  let state;
  await step('the imported history and the setup show in one intact audit chain', async () => {
    state = (await inPage('/api/state')).body;
    assert.equal(state.audit.ok, true, state.audit.problem);
    const types = state.audit.recent.map((e) => e.type);
    assert.ok(types.includes('history_imported') && types.includes('passkey_added'), types.join(','));
    assert.equal(state.cloud.owner, 'Deb');
    assert.equal(state.cloud.passkeys.length, 1);
    assert.ok(state.accounts.some((a) => a.id === LIVE_D && a.mode === 'google_ads'), 'the live Google Ads account is listed');
    assert.ok(state.proposals.some((p) => p.status === 'applied' && p.requestedBy === 'agent (laptop)'));
  });

  await step('this phone subscribes to notifications (a fake push service on this computer)', async () => {
    const r = await inPage('/api/push/subscribe', 'POST', { subscription, device: 'iPhone' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const bad = await inPage('/api/push/subscribe', 'POST', { subscription: { ...subscription, endpoint: 'https://example.com/push' }, device: 'x' });
    assert.equal(bad.status, 400, 'only real push services are accepted');
    const t = await inPage('/api/push/test', 'POST', {});
    assert.equal(t.body.sent, 1);
    const got = await waitFor('the test notification', () => push.received.find((x) => x.message && x.message.tag === 'test'));
    assert.match(got.message.body, /Notifications work/);
    assert.match(got.headers.authorization, /^vapid t=.+, k=.+/);
    assert.equal(got.headers['content-encoding'], 'aes128gcm');
  });

  // ---------- connecting an AI app: OAuth 2.1 with PKCE, consent signed by the passkey ----------

  // The app's callback runs on this computer, so nothing in this check reaches the internet.
  // (Claude's real callback is https://claude.ai/api/mcp/auth_callback; the flow is the same.)
  const callbacks = [];
  const cbServer = http.createServer((req, res) => {
    callbacks.push(`http://127.0.0.1:${cbServer.address().port}${req.url}`);
    res.writeHead(200, { 'Content-Type': 'text/html' }).end('<p>back in the app</p>');
  });
  await new Promise((r) => cbServer.listen(0, '127.0.0.1', r));
  procs.push({ kill: () => cbServer.close() });
  const REDIRECT = `http://127.0.0.1:${cbServer.address().port}/callback`;
  let token;
  let refreshToken;
  let clientId;
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

  await step('an MCP request without a token gets 401 with the OAuth metadata link', async () => {
    const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{}' });
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate'), /resource_metadata="http:\/\/localhost:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
    const meta = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.equal(meta.resource, `${BASE}/mcp`);
    const as = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
    assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
    assert.ok(as.token_endpoint_auth_methods_supported.includes('none'));
  });

  await step('the AI app registers and the owner allows it with the passkey', async () => {
    const reg = await fetch(`${BASE}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude (e2e)', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
    const client = await reg.json();
    assert.equal(reg.status, 201, JSON.stringify(client));
    clientId = client.client_id;
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'st-123', scope: 'campaign-ops offline_access', resource: `${BASE}/mcp` });
    await page.goto(`${BASE}/authorize?${q}`);
    await page.locator('h1', { hasText: 'Allow Claude (e2e) to use Campaign Ops?' }).waitFor();
    await page.locator('text=It can never').waitFor();
    await page.locator('text=an app on your computer').waitFor(); // the loopback warning
    await page.click('#allow');
    const callback = await waitFor('the redirect back to the app', () => callbacks[0], 15_000);
    const back = new URL(callback);
    assert.equal(back.searchParams.get('iss'), BASE, 'the issuer is named in the redirect (RFC 9207)');
    assert.equal(back.searchParams.get('state'), 'st-123');
    const code = back.searchParams.get('code');
    assert.ok(code);
    const tr = await fetch(`${BASE}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: `${BASE}/mcp` }) });
    const tok = await tr.json();
    assert.equal(tr.status, 200, JSON.stringify(tok));
    token = tok.access_token;
    refreshToken = tok.refresh_token;
    assert.ok(token && refreshToken);
    assert.match(tok.scope, /campaign-ops/);
  });

  await step('a denied consent and a reused code both fail', async () => {
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'st-deny', scope: 'campaign-ops', resource: `${BASE}/mcp` });
    await page.goto(`${BASE}/authorize?${q}`);
    await page.click('#deny');
    const denied = await waitFor('the deny redirect', () => callbacks.find((u) => u.includes('st-deny')));
    assert.equal(new URL(denied).searchParams.get('error'), 'access_denied');
    const bad = await fetch(`${BASE}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: 'not-a-code', redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier }) });
    assert.equal(bad.status, 400);
  });

  let rpc = 1;
  async function mcp(method, params) {
    const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: rpc++, method, params }) });
    const text = await r.text();
    assert.equal(r.status, 200, text.slice(0, 300));
    const msg = JSON.parse(text);
    if (msg.error) throw new Error(`MCP error ${msg.error.code}: ${msg.error.message}`);
    return msg.result;
  }
  const tool = async (name, args = {}) => {
    const res = await mcp('tools/call', { name, arguments: args });
    if (res.isError) throw new Error(`${name} failed: ${res.content.map((c) => c.text).join(' ')}`);
    return res.structuredContent;
  };

  await step('MCP over the token: initialize, tools, and passkey-only approvals', async () => {
    const init = await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'claude-e2e', version: '1.0.0' } });
    assert.equal(init.serverInfo.name, 'campaign-ops-mcp');
    assert.match(init.instructions, /signing the exact change with their passkey/);
    const tools = (await mcp('tools/list', {})).tools.map((t) => t.name);
    for (const t of ['list_accounts', 'propose_change', 'apply_change', 'check_pulse', 'verify_with_google']) assert.ok(tools.includes(t), t);
    const policy = await tool('get_policy');
    assert.deepEqual(policy.approvals.approval_channels, ['Campaign Ops approval console, signed with a passkey']);
    const get = await fetch(`${BASE}/mcp`, { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' } });
    assert.equal(get.status, 405, 'no standing event stream');
  });

  let sandboxId;
  let pSandbox;
  await step('a proposal over MCP waits for a passkey and reaches the phone', async () => {
    const accounts = await tool('list_accounts');
    const sb = accounts.accounts.find((a) => a.mode === 'sandbox');
    sandboxId = sb.id;
    const overview = await tool('get_account_overview', { account_id: sandboxId, days: 7 });
    const c = overview.campaigns.find((x) => x.status === 'ENABLED');
    const before = push.received.length;
    const out = await tool('propose_change', { account_id: sandboxId, change: { type: 'set_campaign_budget', campaign_id: c.id, new_daily_budget: Math.round(c.dailyBudget * 1.12) }, reason: 'Search impression share lost to budget is high on the best campaign this week.' });
    pSandbox = out.id;
    assert.equal(out.status, 'pending_approval');
    assert.equal(out.approve_link, `${BASE}/#p=${pSandbox}`);
    assert.match(out.next_step, /with their passkey/);
    const note = await waitFor('the waiting notification', () => push.received.slice(before).find((x) => x.message && x.message.tag === pSandbox));
    assert.match(note.message.title, /needs you/);
    assert.equal(note.message.url, `/#p=${pSandbox}`);
    const applyEarly = await tool('apply_change', { proposal_id: pSandbox });
    assert.equal(applyEarly.status, 'awaiting_approval', 'no in-chat approval prompt in the cloud, even when the app offers one');
  });

  await step('approving without a passkey signature, or with one for another change, is refused', async () => {
    const none = await inPage(`/api/proposals/${pSandbox}/approve`, 'POST', {});
    assert.equal(none.status, 400);
    assert.match(none.body.error, /needs your passkey/);
    // A real signature, but over a different action, must not approve this change.
    const opts = await inPage('/api/passkey/options', 'POST', { purpose: 'resume_all', target: 'all' });
    const proof = await page.evaluate(async (o) => {
      const b = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (ch) => ch.charCodeAt(0));
      const e = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const cred = await navigator.credentials.get({ publicKey: { challenge: b(o.options.challenge), rpId: o.options.rpId, userVerification: 'required', allowCredentials: o.options.allowCredentials.map((c) => ({ type: 'public-key', id: b(c.id) })) } });
      return { challengeId: o.challengeId, assertion: { id: cred.id, type: cred.type, response: { clientDataJSON: e(cred.response.clientDataJSON), authenticatorData: e(cred.response.authenticatorData), signature: e(cred.response.signature) } } };
    }, opts.body);
    const wrong = await inPage(`/api/proposals/${pSandbox}/approve`, 'POST', { proof });
    assert.equal(wrong.status, 400);
    assert.match(wrong.body.error, /different action/);
    const replay = await inPage('/api/kill-switch', 'POST', { on: false, proof });
    assert.equal(replay.status, 400, 'a used challenge cannot be replayed');
  });

  await step('the approve link opens the slip; Approve with passkey signs this exact change', async () => {
    await page.goto(`${BASE}/#p=${pSandbox}`);
    const slip = page.locator(`#slip-${pSandbox}`);
    await slip.waitFor();
    await slip.locator('.from-chat').waitFor();
    const fp = (await slip.locator('.fp').textContent()).replace(' ', '');
    const p = (await inPage('/api/state')).body.proposals.find((x) => x.id === pSandbox);
    assert.equal(fp, p.bindingHash.slice(0, 8).toUpperCase(), 'the fingerprint on the slip is the hash the passkey signs');
    await slip.locator('[data-act="approve"]', { hasText: 'Approve with passkey' }).click();
    await toast(`Approved and signed ${pSandbox}`);
    const after = (await inPage('/api/state')).body.proposals.find((x) => x.id === pSandbox);
    assert.equal(after.status, 'approved');
    assert.match(after.approval.by, /^Deb \(passkey on iPhone\)$/);
    assert.equal(after.approval.evidence.kind, 'passkey');
    assert.equal(after.approval.evidence.binding, after.bindingHash);
    const applied = await tool('apply_change', { proposal_id: pSandbox });
    assert.equal(applied.status, 'applied', JSON.stringify(applied).slice(0, 600));
  });

  let pLive;
  await step('a live account stays read-only until a change window is opened with the passkey', async () => {
    const overview = await tool('get_account_overview', { account_id: LIVE_D, days: 7 });
    const c = overview.campaigns.find((x) => x.status === 'ENABLED');
    const out = await tool('propose_change', { account_id: LIVE_D, change: { type: 'set_campaign_budget', campaign_id: c.id, new_daily_budget: Math.round(c.dailyBudget * 1.1) }, reason: 'Budget-limited all week with strong cost per lead, so a small raise is safe.' });
    assert.equal(out.status, 'pending_approval', JSON.stringify(out).slice(0, 400));
    pLive = out.id;
    await page.goto(`${BASE}/#p=${pLive}`);
    await page.locator(`#slip-${pLive} [data-act="approve"]`).click();
    await toast('Open a change window so it can be applied');
    const writes = google.fake.writes().length;
    const locked = await tool('apply_change', { proposal_id: pLive });
    assert.notEqual(locked.status, 'applied', 'nothing is applied while the account is read-only');
    assert.equal(google.fake.writes().length, writes);
    // On a phone the account cards live on the Watch tab.
    await page.click('[data-act="tab"][data-id="watch"]');
    await page.locator(`[data-act="window"][data-id="${LIVE_D}"]:visible`).first().click();
    await page.fill('#dlg-confirm', LIVE_NAME);
    await page.click('[data-act="window-open"]');
    await toast(`Change window open for ${LIVE_NAME}`);
    const applied = await tool('apply_change', { proposal_id: pLive });
    assert.equal(applied.status, 'applied', JSON.stringify(applied).slice(0, 300));
    assert.ok(google.fake.writes().length > writes, 'the change reached Google Ads');
    const audit = (await inPage('/api/state')).body.audit.recent;
    const opened = audit.find((e) => e.type === 'change_window_opened');
    assert.match(opened.actor, /passkey on iPhone/);
  });

  await step('undo needs the passkey too, and Google records the robot changes', async () => {
    await page.goto(BASE);
    await page.locator(`[data-act="undo"][data-id="${pSandbox}"]`).click();
    await toast(`Undone. ${pSandbox} was reverted`);
    const st = (await inPage('/api/state')).body;
    const original = st.proposals.find((x) => x.id === pSandbox);
    assert.equal(original.status, 'rolled_back');
    const rb = st.proposals.find((x) => x.rollbackOf === pSandbox);
    assert.equal(rb.approval.evidence.purpose, 'undo');
    const witness = await tool('verify_with_google', { account_id: LIVE_D });
    assert.ok(witness.robot_changes.matched >= 1, JSON.stringify(witness).slice(0, 400));
    assert.equal(witness.unexplained_robot_changes.length, 0);
  });

  await step('every stored signature checks out again, from the Record page', async () => {
    await page.click('[data-act="tab"][data-id="record"]');
    await page.click('[data-act="sig-check"]');
    await page.locator('.settings .quiet-line', { hasText: 'check out' }).waitFor();
    const sig = (await inPage('/api/signatures')).body;
    assert.equal(sig.valid, sig.total);
    assert.ok(sig.total >= 3, `expected at least 3 signatures, got ${sig.total}`);
    await page.click('[data-act="tab"][data-id="approve"]');
    await page.locator('.seal-tag.ok:visible').first().waitFor();
  });

  await step('pausing needs no passkey; resuming does', async () => {
    const pause = await inPage('/api/kill-switch', 'POST', { on: true });
    assert.equal(pause.status, 200);
    const plain = await inPage('/api/kill-switch', 'POST', { on: false });
    assert.equal(plain.status, 400);
    await page.goto(BASE);
    await page.click('[data-act="resume"]');
    await toast('Changes resumed');
  });

  await step('the morning watch sends one Pulse alarm and does not repeat it', async () => {
    const before = push.received.length;
    const r = await fetch(`${BASE}/__scheduled?cron=7+13+*+*+*`);
    assert.equal(r.status, 200);
    const pulse = await waitFor('the Pulse notification', () => push.received.slice(before).find((x) => x.message && /^Pulse: /.test(x.message.title)), 20_000);
    assert.match(pulse.message.url, /^\/#a=/);
    const count = push.received.length;
    await fetch(`${BASE}/__scheduled?cron=7+13+*+*+*`);
    await sleep(2500);
    assert.equal(push.received.slice(count).filter((x) => x.message && /^Pulse: /.test(x.message.title)).length, 0, 'the same alarm is not sent twice');
    await page.goto(`${BASE}${pulse.message.url}`);
    await page.locator('.watch .alarm').first().waitFor();
    assert.equal(await page.locator('#app').getAttribute('data-tab'), 'watch');
  });

  await step('the refresh token gets a new access token that works', async () => {
    const r = await fetch(`${BASE}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }) });
    const t = await r.json();
    assert.equal(r.status, 200, JSON.stringify(t));
    token = t.access_token;
    const accounts = await tool('list_accounts');
    assert.ok(accounts.accounts.length >= 2);
  });

  await step('a second device adds its own passkey; the first can then be removed', async () => {
    const firstId = state.cloud.passkeys[0].id;
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: phone });
    phone = (await authenticator()).authenticatorId; // a new laptop with Windows Hello
    await page.goto(BASE);
    await page.click('[data-act="tab"][data-id="record"]');
    await page.click('[data-act="passkey-add"]');
    await toast('Passkey added');
    let keys = (await inPage('/api/state')).body.cloud.passkeys;
    assert.equal(keys.length, 2);
    await page.click(`[data-act="passkey-remove"][data-id="${firstId}"]`);
    await page.click(`[data-act="passkey-remove"][data-id="${firstId}"]`);
    await toast('Passkey removed');
    keys = (await inPage('/api/state')).body.cloud.passkeys;
    assert.equal(keys.length, 1);
    const only = await inPage('/api/passkeys/remove', 'POST', { id: keys[0].id });
    assert.equal(only.status, 400);
  });

  await step('signing out ends the session; signing in again works with the new passkey', async () => {
    await page.click('[data-act="signout"]');
    await page.locator('[data-gate="login"]').waitFor();
    assert.equal((await inPage('/api/state')).status, 401);
    await page.click('[data-gate="login"]');
    await page.locator('.hero-title').waitFor();
  });

  await step('app registrations a stranger can start are capped per day', async () => {
    const register = () => fetch(`${BASE}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'spam', redirect_uris: ['https://example.com/cb'], token_endpoint_auth_method: 'none' }) });
    const statuses = [];
    for (let i = 0; i < 20; i++) statuses.push((await register()).status);
    assert.equal(statuses.filter((x) => x === 201).length, 19, 'one registration was already used by the connector above');
    assert.equal(statuses[statuses.length - 1], 429);
  });

  await step('the console works at phone and desktop widths with no page errors', async () => {
    for (const width of [360, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(BASE);
      await page.locator('.hero-title').waitFor();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, `page scrolls sideways at ${width}px by ${overflow}px`);
    }
    assert.deepEqual(errors, []);
  });
} catch (e) {
  if (!failures) {
    failures++;
    results.push(`  ✕ ${e.message}`);
    console.error(e);
  }
} finally {
  if (browser) await browser.close().catch(() => undefined);
  for (const p of procs) p.kill();
  if (cloud) await cloud.stop();
  console.log(`\nCloud end-to-end:\n${results.join('\n')}\n${failures ? 'FAILED' : 'All passed.'}`);
  process.exit(failures ? 1 : 0);
}
