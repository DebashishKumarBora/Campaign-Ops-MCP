import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Engine } from '../governance/engine.js';
import type { AdsBackend } from '../backends/backend.js';
import { UserError } from '../types.js';
import { safeEqual } from '../util/hash.js';
import { checkPulse } from '../governance/pulse.js';

/**
 * The human approval console: a small web page on 127.0.0.1.
 *
 * Security model:
 *  - Binds to 127.0.0.1 only.
 *  - Every API call needs the console key (X-Console-Token header). The key is
 *    never included in any MCP tool output, so the AI cannot read it.
 *  - Host header must be 127.0.0.1 or localhost (blocks DNS rebinding).
 *  - POST requests must be JSON and same-origin (blocks cross-site form posts).
 *  - Strict Content-Security-Policy and frame-ancestors 'none' (blocks injected
 *    scripts and clickjacking). Text from the AI is escaped before display.
 *  - Change windows for live accounts can only be opened here, by a person who
 *    types the account name. No MCP tool can open one.
 */

export interface ConsoleOptions {
  engine: Engine;
  backend: AdsBackend;
  token: string;
  port: number;
  uiDir: string;
  version: string;
}

export interface ConsoleHandle {
  port: number;
  url: string;
  urlWithKey: string;
  close(): Promise<void>;
}

const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/fonts/source-serif-4-roman.woff2': { file: 'fonts/source-serif-4-roman.woff2', type: 'font/woff2' },
  '/fonts/source-serif-4-italic.woff2': { file: 'fonts/source-serif-4-italic.woff2', type: 'font/woff2' },
};

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function send(res: http.ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8'): void {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type });
  res.end(payload);
}

async function readBody(req: http.IncomingMessage, limit = 10_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new UserError('Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {});
      } catch {
        reject(new UserError('Body must be JSON.'));
      }
    });
    req.on('error', reject);
  });
}

/** How long Pulse and witness results are reused. Both read the ad platform, which has daily limits. */
const INSIGHT_TTL_MS = 5 * 60_000;
/** "Check again" is ignored for results younger than this, so repeated clicks cannot burn through the daily limit. */
const INSIGHT_MIN_REFRESH_MS = 20_000;

export function startConsole(opts: ConsoleOptions): Promise<ConsoleHandle> {
  const { engine, backend } = opts;
  let actualPort = opts.port;
  const insights = new Map<string, { at: number; sig: string; data: Record<string, unknown> }>();

  /** Changes whenever a change is applied, so results never hide a fresh change. */
  const appliedSignature = (accountId: string): string => {
    const applied = engine.store.list().filter((p) => p.accountId === accountId && p.appliedAt);
    return `${applied.length}:${applied.map((p) => p.appliedAt).sort().pop() ?? ''}`;
  };

  async function insightsFor(accountId: string, refresh: boolean): Promise<Record<string, unknown>> {
    const account = await backend.getAccount(accountId);
    if (!account) throw new UserError(`Unknown account ${accountId}.`);
    const now = Date.now();
    const sig = appliedSignature(account.id);
    const hit = insights.get(account.id);
    if (hit && hit.sig === sig && (now - hit.at < (refresh ? INSIGHT_MIN_REFRESH_MS : INSIGHT_TTL_MS))) return { ...hit.data, cached: true };
    const [pulse, witness] = await Promise.all([
      checkPulse(backend, account.id, { days: 28 }).catch((e: Error) => ({ error: e.message })),
      engine.witness(account.id, 14).catch((e: Error) => ({ error: e.message })),
    ]);
    const data = { accountId: account.id, checkedAt: new Date(now).toISOString(), pulse, witness };
    insights.set(account.id, { at: now, sig, data });
    return { ...data, cached: false };
  }

  const allowedHosts = () => new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);
  const allowedOrigins = () => new Set([`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`]);

  const server = http.createServer(async (req, res) => {
    try {
      const host = (req.headers.host ?? '').toLowerCase();
      if (!allowedHosts().has(host)) return send(res, 421, { error: 'Unexpected Host header.' });

      const url = new URL(req.url ?? '/', `http://${host}`);
      const pathname = url.pathname;

      if (req.method === 'GET' && pathname === '/health') return send(res, 200, { ok: true, app: 'campaign-ops-console', version: opts.version });

      if (req.method === 'GET' && STATIC[pathname]) {
        const asset = STATIC[pathname];
        const body = fs.readFileSync(path.join(opts.uiDir, asset.file));
        return send(res, 200, body, asset.type);
      }

      if (!pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found.' });

      const token = req.headers['x-console-token'];
      if (typeof token !== 'string' || !safeEqual(token, opts.token)) return send(res, 401, { error: 'Missing or wrong console key.' });

      if (req.method === 'GET' && pathname === '/api/insights') {
        const id = url.searchParams.get('account') ?? '';
        if (!/^[A-Za-z0-9-]{3,40}$/.test(id)) return send(res, 400, { error: 'Pass ?account= with an account ID.' });
        return send(res, 200, await insightsFor(id, url.searchParams.get('refresh') === '1'));
      }

      if (req.method === 'GET' && pathname === '/api/state') {
        const listed = await backend.listAccounts();
        const accounts = [];
        for (const a of listed) accounts.push({ ...a, access: await engine.liveAccess(a.id) });
        const proposals = await engine.listProposals({ limit: 80 });
        const chain = engine.audit.verify();
        const recent = engine.audit.recent(14);
        const since = engine.now() - 86_400_000;
        const all = engine.store.list();
        return send(res, 200, {
          app: { name: 'Campaign Ops', version: opts.version },
          mode: backend.mode,
          account: accounts[0] ?? null,
          accounts,
          scope: engine.scope,
          killSwitch: engine.killSwitchState(),
          policy: engine.policy,
          counts: {
            pending: all.filter((p) => p.status === 'pending_approval').length,
            appliedToday: all.filter((p) => p.appliedAt && Date.parse(p.appliedAt) >= since).length,
            blocked: all.filter((p) => p.status === 'blocked').length,
          },
          proposals,
          audit: { ok: chain.ok, count: chain.count, problem: chain.problem, recent },
          serverTime: new Date(engine.now()).toISOString(),
        });
      }

      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (origin && !allowedOrigins().has(origin.toLowerCase())) return send(res, 403, { error: 'Cross-origin request refused.' });
        const contentType = (req.headers['content-type'] ?? '').toLowerCase();
        if (!contentType.startsWith('application/json')) return send(res, 415, { error: 'Content-Type must be application/json.' });
        const body = await readBody(req);
        const note = typeof body.note === 'string' ? body.note : undefined;
        const who = 'person (console)';

        const match = /^\/api\/proposals\/(P-\d{4,})\/(approve|reject|undo)$/.exec(pathname);
        if (match) {
          const [, id, action] = match;
          if (action === 'approve') return send(res, 200, { ok: true, proposal: await engine.approve(id, { by: who, channel: 'console', note }) });
          if (action === 'reject') return send(res, 200, { ok: true, proposal: await engine.reject(id, { by: who, channel: 'console', note }) });
          const result = await engine.undoNow(id, who);
          const blocked = result.rollback.status === 'blocked';
          const applied = result.outcome?.status === 'applied';
          return send(res, 200, {
            ok: applied,
            rollback: result.rollback,
            outcome: result.outcome ? { status: result.outcome.status, message: result.outcome.message } : undefined,
            message: blocked
              ? `Undo blocked: ${result.rollback.checks.filter((c) => c.status === 'fail').map((c) => c.detail ?? c.label).join(' ')}`
              : result.outcome?.message ?? 'Undo requested.',
          });
        }

        const win = /^\/api\/accounts\/([A-Za-z0-9-]{3,40})\/window(\/close)?$/.exec(pathname);
        if (win) {
          const [, accountId, close] = win;
          if (close) {
            await engine.closeChangeWindow(accountId, who);
            return send(res, 200, { ok: true, access: await engine.liveAccess(accountId) });
          }
          const window = await engine.openChangeWindow(accountId, { hours: Number(body.hours), confirmName: typeof body.confirm === 'string' ? body.confirm : '', by: who });
          return send(res, 200, { ok: true, window, access: await engine.liveAccess(accountId) });
        }

        if (pathname === '/api/kill-switch') {
          if (typeof body.on !== 'boolean') return send(res, 400, { error: 'Send {"on": true} or {"on": false}.' });
          await engine.setKillSwitch(body.on, who);
          return send(res, 200, { ok: true, killSwitch: engine.killSwitchState() });
        }
      }

      return send(res, 404, { error: 'Not found.' });
    } catch (e) {
      if (e instanceof UserError) return send(res, 400, { error: e.message });
      console.error('[campaign-ops] console error:', e);
      return send(res, 500, { error: 'Unexpected error. See the server log.' });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => {
      actualPort = (server.address() as AddressInfo).port;
      server.off('error', reject);
      const url = `http://127.0.0.1:${actualPort}/`;
      resolve({
        port: actualPort,
        url,
        urlWithKey: `${url}#key=${opts.token}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}

export async function consoleIsRunning(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) });
    if (!res.ok) return false;
    const body = (await res.json()) as { app?: string };
    return body.app === 'campaign-ops-console';
  } catch {
    return false;
  }
}
