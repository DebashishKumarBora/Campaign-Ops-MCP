import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Engine } from '../governance/engine.js';
import type { AdsBackend } from '../backends/backend.js';
import { UserError } from '../types.js';
import { safeEqual } from '../util/hash.js';
import { ConsoleApi } from './api.js';
import type { Autopilot } from '../autopilot/autopilot.js';

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
  /** Autopilot, shown and controlled in the console. */
  autopilot?: Autopilot;
  /** Run Autopilot's hourly check while this console is open. */
  tick?: boolean;
}

/** How often Autopilot checks while a console runs on a computer. */
const TICK_MS = 60 * 60_000;
/** The first check after the console starts. */
const FIRST_TICK_MS = 2 * 60_000;

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
  '/theme.js': { file: 'theme.js', type: 'text/javascript; charset=utf-8' },
  '/fonts/plus-jakarta-sans.woff2': { file: 'fonts/plus-jakarta-sans.woff2', type: 'font/woff2' },
  '/manifest.webmanifest': { file: 'manifest.webmanifest', type: 'application/manifest+json' },
  '/icons/apple-touch-icon.png': { file: 'icons/apple-touch-icon.png', type: 'image/png' },
  '/icons/icon-192.png': { file: 'icons/icon-192.png', type: 'image/png' },
  '/icons/icon-512.png': { file: 'icons/icon-512.png', type: 'image/png' },
  '/icons/icon-maskable-512.png': { file: 'icons/icon-maskable-512.png', type: 'image/png' },
};

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
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

export function startConsole(opts: ConsoleOptions): Promise<ConsoleHandle> {
  const { engine, backend } = opts;
  let actualPort = opts.port;
  const autopilot = opts.autopilot;
  const api = new ConsoleApi({ engine, backend, version: opts.version, autopilot, runAutopilot: autopilot ? (jobs) => autopilot.runAll(jobs) : undefined });

  // Autopilot on a computer: checks every hour while the console is open.
  let busy = false;
  const tick = async () => {
    if (!autopilot || busy) return;
    busy = true;
    try {
      await autopilot.runAll(await autopilot.plan());
    } catch (e) {
      console.error('[campaign-ops] autopilot check failed:', (e as Error).message);
    } finally {
      busy = false;
    }
  };
  const timers: NodeJS.Timeout[] = [];
  if (autopilot && opts.tick) {
    timers.push(setTimeout(() => void tick(), FIRST_TICK_MS), setInterval(() => void tick(), TICK_MS));
    for (const t of timers) t.unref();
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
      // Tells the page which sign-in to show: the console key here, a passkey in the cloud.
      if (req.method === 'GET' && pathname === '/mode') return send(res, 200, { mode: 'local' });

      if (req.method === 'GET' && STATIC[pathname]) {
        const asset = STATIC[pathname];
        const body = fs.readFileSync(path.join(opts.uiDir, asset.file));
        return send(res, 200, body, asset.type);
      }

      if (!pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found.' });

      const token = req.headers['x-console-token'];
      if (typeof token !== 'string' || !safeEqual(token, opts.token)) return send(res, 401, { error: 'Missing or wrong console key.' });

      let body: Record<string, unknown> = {};
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (origin && !allowedOrigins().has(origin.toLowerCase())) return send(res, 403, { error: 'Cross-origin request refused.' });
        const contentType = (req.headers['content-type'] ?? '').toLowerCase();
        if (!contentType.startsWith('application/json')) return send(res, 415, { error: 'Content-Type must be application/json.' });
        body = await readBody(req);
      }
      const result = await api.handle({ method: req.method ?? 'GET', pathname, query: url.searchParams, body, who: 'person (console)' });
      if (result) return send(res, result.status, result.body);

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
            for (const t of timers) clearTimeout(t);
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
