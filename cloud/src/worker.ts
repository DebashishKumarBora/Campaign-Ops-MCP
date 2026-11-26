import { OAuthProvider, AuthorizationError, CimdFetchError, type ConsentDescription } from '@cloudflare/workers-oauth-provider';
import type { Env } from './env.js';
import type { CampaignOps } from './ops.js';

export { CampaignOps } from './ops.js';

/**
 * Campaign Ops on Cloudflare Workers.
 *
 *   /mcp                 the MCP server for Claude, behind OAuth 2.1 (this library checks the tokens)
 *   /authorize           the consent page: allowing Claude needs your passkey
 *   /oauth/token, /oauth/register, /.well-known/*   served by the OAuth library
 *   /, /app.js, ...      the approval console (static files)
 *   /api/*, /auth/*      the console's API and passkey sign-in (in the Durable Object)
 *   cron                 Autopilot's hourly tick: the watch, the daily review, notifications
 */

const SCOPE = 'campaign-ops';

const STATIC = new Set(['/', '/index.html', '/app.js', '/app.css', '/theme.js', '/sw.js', '/manifest.webmanifest', '/consent.js']);
const isStatic = (path: string) => STATIC.has(path) || path.startsWith('/fonts/') || path.startsWith('/icons/');

const BASE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const SECURITY: Record<string, string> = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

function secure(res: Response, extra: Record<string, string> = {}): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries({ ...SECURITY, ...extra })) if (!out.headers.has(k)) out.headers.set(k, v);
  return out;
}

const ops = (env: Env): DurableObjectStub<CampaignOps> => env.OPS.get(env.OPS.idFromName('main'));

const escape = (value: string) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---------- the consent page ----------

/** The same mark the app draws (console-ui/app.js brandMark), with its gradient defined inline. */
const BRAND_MARK = '<svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="cops-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6d5ef8"/><stop offset=".6" stop-color="#22d3ee"/><stop offset="1" stop-color="#f471b5"/></linearGradient></defs><rect width="32" height="32" rx="9" fill="#0e1019"/><circle cx="16" cy="16" r="9.5" fill="none" stroke="url(#cops-grad)" stroke-width="3"/><path d="M11.8 16.4l2.9 2.9 5.6-6.1" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function consentPage(d: ConsentDescription, handle: string, origin: string): string {
  const name = escape(d.clientName || 'An app');
  const publisher = d.clientDomain ? `Published by <strong>${escape(d.clientDomain)}</strong>.` : 'This app registered itself, so its name is not verified.';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Allow ${name} to use Campaign Ops</title>
<script src="/theme.js"></script>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<main class="gate gate-cloud consent">
  <p class="gate-mark">${BRAND_MARK}Campaign Ops</p>
  <h1>Allow ${name} to use Campaign Ops?</h1>
  <p>${publisher} Access goes to <strong>${escape(d.redirectHost)}</strong>.</p>
  ${d.redirectIsLoopback ? '<p class="error">This sends access to an app on your computer. Continue only if you just started connecting from it.</p>' : ''}
  <div class="consent-box">
    <p><strong>It can</strong> read your accounts, run health checks, Pulse and the check against Google's record, and propose changes.</p>
    <p><strong>It can never</strong> approve a change, undo one, or unlock a live account. Only you can, with your passkey on ${escape(new URL(origin).hostname)}.</p>
  </div>
  <form id="consent-form" method="post" action="/authorize" autocomplete="off">
    <input type="hidden" name="handle" value="${escape(handle)}">
    <input type="hidden" name="challengeId" value="">
    <input type="hidden" name="assertion" value="">
    <div class="consent-actions">
      <button class="btn btn-sign" type="button" id="allow">Allow with your passkey</button>
      <button class="btn btn-quiet" type="submit" id="deny" name="decision" value="deny">Deny</button>
    </div>
    <p class="error" id="consent-error" role="alert"></p>
  </form>
</main>
<script src="/consent.js"></script>
</body>
</html>`;
}

function errorPage(message: string, status = 400): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>Campaign Ops</title><script src="/theme.js"></script><link rel="stylesheet" href="/app.css"></head><body><main class="gate"><h1>That did not work</h1><p>${escape(message)}</p><p>Go back to Claude and connect again.</p></main></body></html>`;
  return secure(new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': BASE_CSP } }));
}

async function authorize(request: Request, env: Env & { OAUTH_PROVIDER: OAuthHelpersLike }): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const url = new URL(request.url);
  try {
    if (request.method === 'GET') {
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      const headers = consent.headers;
      headers.set('Content-Type', 'text/html; charset=utf-8');
      headers.set('Cache-Control', 'no-store');
      // The form posts here, then the browser is sent back to the app: allow exactly that destination.
      headers.set('Content-Security-Policy', BASE_CSP.replace("form-action 'none'", `form-action 'self' ${new URL(details.redirectUri).origin}`));
      return secure(new Response(consentPage(details, consent.handle, url.origin), { headers }));
    }
    if (request.method === 'POST') {
      const form = await request.formData();
      const handle = String(form.get('handle') ?? '');
      if (form.get('decision') !== 'approve') {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      let assertion: unknown;
      try {
        assertion = JSON.parse(String(form.get('assertion') ?? ''));
      } catch {
        return errorPage('Your passkey did not answer. Try connecting again.');
      }
      const proof = await ops(env).verifyConsent(url.origin, handle, String(form.get('challengeId') ?? ''), assertion as never);
      if (!proof.ok) return errorPage(proof.error ?? 'The passkey check failed.', 403);
      const approved = await oauth.approveConsent(request, handle, {});
      const scope = approved.request.scope.filter((s: string) => s === SCOPE || s === 'offline_access');
      if (!scope.includes(SCOPE)) scope.push(SCOPE);
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: 'owner',
        metadata: { passkey: proof.passkey },
        scope,
        props: { owner: proof.owner, passkey: proof.passkey },
      });
      approved.headers.set('Location', redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    }
    return errorPage('Method not allowed.', 405);
  } catch (e) {
    if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
    if (e instanceof AuthorizationError) return errorPage(e.description);
    if (e instanceof CimdFetchError) return errorPage('This app could not be verified.');
    throw e;
  }
}

// The OAuth library adds these helpers to env for the default handler.
type OAuthHelpersLike = {
  parseAuthRequest(request: Request): Promise<{ scope: string[]; redirectUri: string; clientId: string; state: string }>;
  describeConsent(authRequest: unknown): Promise<ConsentDescription>;
  beginConsent(authRequest: unknown): Promise<{ handle: string; headers: Headers }>;
  approveConsent(request: Request, handle: string, options?: Record<string, unknown>): Promise<{ request: { scope: string[] } & Record<string, unknown>; headers: Headers }>;
  denyConsent(request: Request, handle: string): Promise<{ headers: Headers }>;
  completeAuthorization(options: Record<string, unknown>): Promise<{ redirectTo: string }>;
};

// ---------- handlers ----------

const apiHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const headers = new Headers(request.headers);
    headers.set('x-ops-via', 'oauth');
    return ops(env).fetch(new Request(request, { headers }));
  },
};

const defaultHandler = {
  async fetch(request: Request, env: Env & { OAUTH_PROVIDER: OAuthHelpersLike }): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/authorize') return authorize(request, env);
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/') || url.pathname === '/admin/import') {
      const headers = new Headers(request.headers);
      headers.delete('x-ops-via');
      return secure(await ops(env).fetch(new Request(request, { headers })));
    }
    return secure(new Response(JSON.stringify({ error: 'Not found.' }), { status: 404, headers: { 'Content-Type': 'application/json' } }));
  },
};

const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string): OAuthProvider<Env> {
  let p = providers.get(origin);
  if (!p) {
    p = new OAuthProvider<Env>({
      apiRoute: '/mcp',
      apiHandler: apiHandler as never,
      defaultHandler: defaultHandler as never,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/oauth/token',
      clientRegistrationEndpoint: '/oauth/register',
      scopesSupported: [SCOPE, 'offline_access'],
      resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
      requiredScopes: [SCOPE],
      clientIdMetadataDocumentEnabled: true,
      refreshTokenTTL: 30 * 86_400,
    });
    providers.set(origin, p);
  }
  return p;
}

async function serveAsset(request: Request, env: Env, path: string): Promise<Response> {
  const res = await env.ASSETS.fetch(request);
  const extra: Record<string, string> = { 'Content-Security-Policy': BASE_CSP };
  if (path === '/sw.js') extra['Service-Worker-Allowed'] = '/';
  if (path === '/' || path === '/index.html' || path.endsWith('.js') || path.endsWith('.css') || path === '/manifest.webmanifest') extra['Cache-Control'] = 'no-cache';
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(extra)) out.headers.set(k, v);
  return secure(out);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if ((request.method === 'GET' || request.method === 'HEAD') && isStatic(url.pathname)) return serveAsset(request, env, url.pathname);
    if (request.method === 'GET' && url.pathname === '/mode') {
      return secure(new Response(JSON.stringify({ mode: 'cloud' }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }));
    }
    // The two OAuth steps a stranger can start each write to KV; a daily budget keeps them from using up the free quota.
    if (request.method === 'GET' && url.pathname === '/authorize' && !(await ops(env).allowOAuthWrite('authorize'))) {
      return errorPage('Too many connection attempts today. Try again tomorrow.', 429);
    }
    if (request.method === 'POST' && url.pathname === '/oauth/register' && !(await ops(env).allowOAuthWrite('register'))) {
      return secure(new Response(JSON.stringify({ error: 'temporarily_unavailable', error_description: 'Too many app registrations today. Try again tomorrow.' }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '86400' } }));
    }
    return providerFor(url.origin).fetch(request, env, ctx);
  },

  /** Every hour: Autopilot's tick. Once a day, expired OAuth grants are cleaned up too. */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const stub = ops(env);
    ctx.waitUntil(
      (async () => {
        try {
          await stub.tick();
        } catch (e) {
          console.error('Autopilot tick failed', e);
        }
        if (new Date(controller.scheduledTime).getUTCHours() !== 9) return;
        try {
          const origin = await stub.knownPublicOrigin();
          await providerFor(origin).purgeExpiredData(env);
        } catch (e) {
          console.error('OAuth cleanup failed', e);
        }
      })(),
    );
  },
};
