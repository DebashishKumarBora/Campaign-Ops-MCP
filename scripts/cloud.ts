/**
 * Campaign Ops in the cloud, on a free Cloudflare account.
 *
 *   npm run cloud:setup           Puts Campaign Ops on Cloudflare, moves your history there once,
 *                                 and prints a one-hour setup code for your first passkey.
 *   npm run cloud:deploy          Updates the code in the cloud after you download a new version.
 *                                 Keeps every secret, passkey and record.
 *   npm run cloud:code            A new one-hour setup code, to add a passkey on a device when you
 *                                 have no signed-in device at hand.
 *   npm run cloud:unlink-desktop  Removes the local copy from Claude Desktop, so Claude sees only
 *                                 the cloud one.
 *
 * Secrets go to Cloudflare through Wrangler's standard input, encrypted at rest there.
 * None of them is written into this folder.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateVapidKeys } from '../src/cloud/push.js';
import { defaultKeyFile, loadSettings, secretsDir } from '../src/backends/googleAds/settings.js';

const SETUP_HOURS = 1;
/** No 0/O, 1/I/L or U, so a code read off a screen is typed right the first time. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

/** Everything the commands touch outside themselves, so a test can stand in for Cloudflare. */
export interface CloudContext {
  /** The campaign-ops-mcp folder. */
  root: string;
  /** Wrangler's entry file. */
  wranglerJs: string;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** One line of output for the person. */
  print: (line: string) => void;
  /** Wrangler's own output, passed through as it arrives. */
  passthrough: (chunk: string) => void;
  env: NodeJS.ProcessEnv;
  /** Pause between checks while a new version goes live. */
  pollMs: number;
}

export function defaultContext(): CloudContext {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  return {
    root,
    wranglerJs: path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
    fetch: (url, init) => fetch(url, init),
    print: (line) => console.log(line),
    passthrough: (chunk) => process.stdout.write(chunk),
    env: process.env,
    pollMs: 2000,
  };
}

export class Stop extends Error {
  constructor(
    message: string,
    readonly fix: string[] = [],
  ) {
    super(message);
  }
}

interface Deployed {
  url: string;
  deployedAt: string;
  imported?: boolean;
}

// ---------- pure helpers (tested directly) ----------

/** Reads JSON with comments, the format Wrangler's settings use. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/**
 * cloud/wrangler.jsonc is made from wrangler.base.jsonc. On the first deploy
 * Wrangler creates the OAuth store and writes its ID into that file, so the ID
 * is carried over every time the file is made again.
 */
export function writeConfig(base: string, existing: string): string {
  let id: string | undefined;
  if (existing) {
    try {
      const cfg = parseJsonc(existing) as { kv_namespaces?: Array<{ binding?: string; id?: string }> };
      id = cfg.kv_namespaces?.find((k) => k.binding === 'OAUTH_KV')?.id;
    } catch {
      id = undefined;
    }
  }
  const text = id ? base.replace('"kv_namespaces": [{ "binding": "OAUTH_KV" }]', `"kv_namespaces": [{ "binding": "OAUTH_KV", "id": "${id}" }]`) : base;
  if (id && text === base) throw new Stop('cloud/wrangler.base.jsonc changed shape, so the OAuth store ID could not be kept.', ['Restore wrangler.base.jsonc from the download and run the command again.']);
  return text;
}

export function newSetupCode(now = Date.now()): { code: string; secret: string } {
  const bytes = crypto.randomBytes(12);
  let raw = '';
  for (const b of bytes) raw += CODE_ALPHABET[b % CODE_ALPHABET.length];
  const code = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
  const hash = crypto.createHash('sha256').update(`campaign-ops-setup:${raw}`).digest('base64url');
  return { code, secret: JSON.stringify({ hash, expiresAt: now + SETUP_HOURS * 3_600_000, epoch: crypto.randomBytes(9).toString('base64url') }) };
}

export function desktopConfigPath(platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude', 'claude_desktop_config.json');
}

/** Removes local Campaign Ops entries from Claude Desktop's settings, after saving a backup. */
export function unlinkDesktop(file = desktopConfigPath()): { removed: string[]; backup?: string } {
  if (!fs.existsSync(file)) return { removed: [] };
  const text = fs.readFileSync(file, 'utf8');
  const cfg = JSON.parse(text) as { mcpServers?: Record<string, { command?: string; args?: string[] }> };
  const servers = cfg.mcpServers ?? {};
  const removed = Object.keys(servers).filter((name) => {
    const s = servers[name];
    const where = [s.command ?? '', ...(s.args ?? [])].join(' ').replace(/\\/g, '/').toLowerCase();
    return name.toLowerCase() === 'campaign-ops' || where.includes('campaign-ops-mcp/dist/src/index.js');
  });
  if (!removed.length) return { removed };
  const backup = file.replace(/\.json$/, `.backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(backup, text);
  for (const name of removed) delete servers[name];
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
  return { removed, backup };
}

// ---------- the commands ----------

class Cloud {
  private readonly cloudDir: string;

  constructor(private readonly ctx: CloudContext) {
    this.cloudDir = path.join(ctx.root, 'cloud');
  }

  private ok = (m: string) => this.ctx.print(`[ OK ] ${m}`);
  private info = (m: string) => this.ctx.print(`[INFO] ${m}`);
  private step = (m: string) => this.ctx.print(`[ .. ] ${m}`);
  private warn = (m: string) => this.ctx.print(`[WARN] ${m}`);
  private line = (m = '') => this.ctx.print(m ? `       ${m}` : '');
  private title = (m: string) => this.ctx.print(`\n${m}\n${'-'.repeat(m.length)}`);

  private wrangler(args: string[], opts: { input?: string; echo?: boolean; interactive?: boolean } = {}): Promise<{ code: number; out: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [this.ctx.wranglerJs, ...args], {
        cwd: this.cloudDir,
        // A sign-in needs the terminal; everything else is read here so the address can be picked out.
        stdio: opts.interactive ? 'inherit' : [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        env: { ...this.ctx.env, WRANGLER_SEND_METRICS: 'false' },
      });
      let out = '';
      const take = (d: Buffer) => {
        out += d.toString();
        if (opts.echo) this.ctx.passthrough(d.toString());
      };
      child.stdout?.on('data', take);
      child.stderr?.on('data', take);
      if (opts.input !== undefined) child.stdin?.end(opts.input);
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? 1, out }));
    });
  }

  private get statePath() {
    return path.join(this.cloudDir, '.deployed.json');
  }

  private readState(): Deployed | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as Deployed;
    } catch {
      return undefined;
    }
  }

  private saveState(s: Deployed): void {
    fs.writeFileSync(this.statePath, `${JSON.stringify({ $note: 'Written by npm run cloud:setup. Not secret.', ...s }, null, 2)}\n`);
  }

  private async ensureWrangler(): Promise<void> {
    if (!fs.existsSync(this.ctx.wranglerJs)) throw new Stop("Wrangler (Cloudflare's tool) is not installed in this folder yet.", ['Run: npm install', 'Then run this command again.']);
    this.step('Checking your Cloudflare sign-in');
    let who = await this.wrangler(['whoami']);
    if (who.code !== 0 || /not authenticated|not logged in/i.test(who.out)) {
      this.info('A browser window opens so you can sign in to Cloudflare and allow Wrangler. Come back here afterwards.');
      const login = await this.wrangler(['login'], { interactive: true });
      if (login.code !== 0) throw new Stop('Cloudflare sign-in did not finish.', ['Run the same command again and complete the sign-in in the browser.']);
      who = await this.wrangler(['whoami']);
      if (who.code !== 0 || /not authenticated|not logged in/i.test(who.out)) throw new Stop('Cloudflare sign-in did not finish.', ['Run the same command again and complete the sign-in in the browser.']);
    }
    const email = /associated with the email ([^\s]+?)\.?(\s|$)/i.exec(who.out)?.[1];
    this.ok(email ? `Signed in to Cloudflare as ${email}` : 'Signed in to Cloudflare');
  }

  private async deploy(): Promise<string> {
    const configPath = path.join(this.cloudDir, 'wrangler.jsonc');
    const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
    fs.writeFileSync(configPath, writeConfig(fs.readFileSync(path.join(this.cloudDir, 'wrangler.base.jsonc'), 'utf8'), existing));
    this.step('Uploading Campaign Ops to Cloudflare (about a minute the first time)');
    const out = await this.wrangler(['deploy'], { echo: true });
    if (out.code !== 0) {
      if (/workers\.dev subdomain/i.test(out.out)) {
        throw new Stop('Your Cloudflare account needs a workers.dev address first.', [
          'Open https://dash.cloudflare.com and choose Workers & Pages (Compute).',
          'Cloudflare asks you to pick a workers.dev subdomain. Pick any name.',
          'Then run the same command again.',
        ]);
      }
      if (/more than one account|multiple accounts/i.test(out.out)) {
        throw new Stop('Your Cloudflare sign-in has more than one account.', ['Set CLOUDFLARE_ACCOUNT_ID to the account you want, then run the same command again.']);
      }
      throw new Stop('Cloudflare did not accept the upload. The messages above say why.');
    }
    const url = /https:\/\/campaign-ops\.[a-z0-9-]+\.workers\.dev/i.exec(out.out)?.[0];
    if (!url) throw new Stop("The upload worked, but the address was not in Wrangler's output.", ['Open the Cloudflare dashboard, Workers & Pages, campaign-ops, and copy its workers.dev address.']);
    this.ok(`Live at ${url.toLowerCase()}`);
    return url.toLowerCase();
  }

  private async existingSecrets(): Promise<Set<string>> {
    const r = await this.wrangler(['secret', 'list', '--format', 'json']);
    try {
      const list = JSON.parse(r.out.slice(r.out.indexOf('['))) as Array<{ name: string }>;
      return new Set(list.map((s) => s.name));
    } catch {
      return new Set();
    }
  }

  private async putSecrets(secrets: Record<string, string | null>): Promise<void> {
    const r = await this.wrangler(['secret', 'bulk'], { input: JSON.stringify(secrets) });
    if (r.code !== 0) throw new Stop('Cloudflare did not accept the secrets.', [r.out.trim().split('\n').slice(-3).join(' ')]);
  }

  private googleSecrets(skip: boolean): { secrets: Record<string, string>; note: string } {
    if (skip) return { secrets: {}, note: 'Google Ads left out (--no-google). The cloud uses the sandbox only.' };
    const settings = loadSettings(this.ctx.env);
    if (!settings || !settings.accounts.length) return { secrets: {}, note: 'No Google Ads account is connected on this computer, so the cloud uses the sandbox only.' };
    const keyFile = settings.keyFile || defaultKeyFile(this.ctx.env);
    if (!fs.existsSync(keyFile)) return { secrets: {}, note: `The robot key is not at ${keyFile}, so Google Ads stays off in the cloud.` };
    const key = fs.readFileSync(keyFile, 'utf8');
    let parsed: { type?: string; client_email?: string };
    try {
      parsed = JSON.parse(key) as { type?: string; client_email?: string };
    } catch {
      throw new Stop(`${keyFile} is not a valid key file.`);
    }
    if (parsed.type !== 'service_account') throw new Stop(`${keyFile} is not a service account key.`);
    const shareable: Record<string, unknown> = { ...settings };
    delete shareable.keyFile; // a path on this computer means nothing in the cloud
    return {
      secrets: { GOOGLE_ADS_KEY: key, GOOGLE_ADS_SETTINGS: JSON.stringify(shareable) },
      note: `Google Ads: ${settings.accounts.map((a) => `${a.name} (${a.id})`).join(', ')}. The robot key (${parsed.client_email}) goes to Cloudflare as an encrypted secret, read from ${secretsDir(this.ctx.env)}.`,
    };
  }

  private async waitForSetupOpen(url: string): Promise<boolean> {
    for (let i = 0; i < 30; i++) {
      try {
        const s = (await (await this.ctx.fetch(`${url}/auth/session`, { headers: { 'Cache-Control': 'no-store' } })).json()) as { setupOpen?: boolean };
        if (s.setupOpen) return true;
      } catch {
        // the new version is still spreading around Cloudflare
      }
      await new Promise((r) => setTimeout(r, this.ctx.pollMs));
    }
    return false;
  }

  private async importHistory(url: string, token: string): Promise<string> {
    const custom = this.ctx.env.CAMPAIGN_OPS_DATA_DIR?.trim();
    const dataDir = custom ? path.resolve(this.ctx.root, custom) : path.join(this.ctx.root, 'data');
    const read = (f: string) => (fs.existsSync(path.join(dataDir, f)) ? fs.readFileSync(path.join(dataDir, f), 'utf8') : '');
    const audit = read('audit.jsonl');
    if (!audit.trim()) return 'No history on this computer to move.';
    const res = await this.ctx.fetch(`${url}/admin/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ proposals: read('proposals.json'), audit, sandbox: read('sandbox.json') }),
    });
    const body = (await res.json().catch(() => ({}))) as { entries?: number; proposals?: number; error?: string };
    if (res.ok) return `Moved your history to the cloud: ${body.proposals} proposals and ${body.entries} audit entries, hash chain checked.`;
    if (res.status === 409) return `History not moved: ${body.error}`;
    throw new Stop(`Moving your history failed: ${body.error ?? res.status}`, ['Your laptop copy is untouched. Run the same command again.']);
  }

  private nextSteps(url: string, code: string): void {
    this.title('Your setup code');
    this.ctx.print('');
    this.ctx.print(`       ${code}`);
    this.ctx.print('');
    this.line(`It works once, for the next ${SETUP_HOURS} hour. Lost it? Run: npm run cloud:code`);
    this.title('Next, on your phone');
    this.line(`1. Open ${url}`);
    this.line('2. Type the setup code, your name and the device name. Tap Create passkey.');
    this.line('3. iPhone: tap Share, then Add to Home Screen. Open Campaign Ops from the Home Screen');
    this.line('   and sign in with Face ID.');
    this.line('4. Tap Turn on notifications.');
    this.title('Then, in Claude');
    this.line('1. Customize, then Connectors, then Add custom connector.');
    this.line(`2. Name: Campaign Ops. URL: ${url}/mcp`);
    this.line('3. Press Connect. Campaign Ops asks for your passkey to allow Claude.');
    this.line('4. On this computer, run: npm run cloud:unlink-desktop');
    this.line('   so Claude Desktop stops starting the old local copy.');
    this.ctx.print('');
  }

  async setup(args: string[]): Promise<void> {
    this.title('Campaign Ops in the cloud');
    await this.ensureWrangler();
    const url = await this.deploy();
    const have = await this.existingSecrets();
    const secrets: Record<string, string | null> = {};
    // Kept when they exist: a new session key would sign everyone out, new notification keys would silence every phone.
    if (!have.has('SESSION_SECRET')) secrets.SESSION_SECRET = crypto.randomBytes(32).toString('base64url');
    if (!have.has('VAPID_PUBLIC_KEY') || !have.has('VAPID_PRIVATE_KEY')) {
      const vapid = await generateVapidKeys();
      secrets.VAPID_PUBLIC_KEY = vapid.publicKey;
      secrets.VAPID_PRIVATE_KEY = JSON.stringify(vapid.privateKey);
    }
    const { code, secret } = newSetupCode();
    secrets.SETUP_CODE = secret;
    const importToken = crypto.randomBytes(32).toString('base64url');
    secrets.IMPORT_TOKEN = importToken;
    const noGoogle = args.includes('--no-google');
    const google = this.googleSecrets(noGoogle);
    Object.assign(secrets, google.secrets);
    if (noGoogle) for (const k of ['GOOGLE_ADS_KEY', 'GOOGLE_ADS_SETTINGS']) if (have.has(k)) secrets[k] = null;
    this.info(google.note);
    this.step('Saving the secrets in Cloudflare (encrypted there, never in this folder)');
    await this.putSecrets(secrets);
    this.ok(`Secrets saved: ${Object.keys(secrets).filter((k) => secrets[k] !== null).join(', ')}`);
    this.step('Waiting for the new version to go live');
    if (!(await this.waitForSetupOpen(url))) this.warn('The new version is taking a while. If the setup code is refused, wait a minute and try again.');
    const state = this.readState();
    if (state?.imported && state.url === url) {
      this.info('Your history was moved earlier, so it was not moved again.');
    } else {
      this.ok(await this.importHistory(url, importToken));
    }
    this.saveState({ url, deployedAt: new Date().toISOString(), imported: true });
    this.nextSteps(url, code);
  }

  async update(): Promise<void> {
    this.title('Update Campaign Ops in the cloud');
    await this.ensureWrangler();
    const url = await this.deploy();
    this.saveState({ ...this.readState(), url, deployedAt: new Date().toISOString() });
    this.ok('Updated. Your passkeys, notifications, proposals and audit log are unchanged.');
  }

  async code(): Promise<void> {
    const state = this.readState();
    if (!state) throw new Stop('Campaign Ops is not in the cloud yet.', ['Run: npm run cloud:setup']);
    await this.ensureWrangler();
    const fresh = newSetupCode();
    this.step('Saving a new setup code');
    await this.putSecrets({ SETUP_CODE: fresh.secret });
    await this.waitForSetupOpen(state.url);
    this.title('New setup code');
    this.ctx.print('');
    this.ctx.print(`       ${fresh.code}`);
    this.ctx.print('');
    this.line(`Open ${state.url} on the device, choose I have a setup code, and create its passkey.`);
    this.line(`It works once, for the next ${SETUP_HOURS} hour.`);
    this.ctx.print('');
  }

  unlink(file = desktopConfigPath(process.platform, this.ctx.env)): void {
    const r = unlinkDesktop(file);
    if (!r.removed.length) {
      this.info(`No local Campaign Ops entry in ${file}. Nothing to change.`);
      return;
    }
    this.ok(`Removed ${r.removed.join(', ')} from Claude Desktop's settings.`);
    this.line(`A copy of the old settings is at ${r.backup}`);
    this.line('Quit Claude Desktop fully (also from the system tray) and open it again.');
    this.line('Claude then uses only the Campaign Ops connector in the cloud.');
  }
}

/** Runs one command. Returns the exit code. */
export async function runCloud(command: string | undefined, args: string[], ctx: CloudContext = defaultContext()): Promise<number> {
  const cloud = new Cloud(ctx);
  try {
    if (command === 'setup') await cloud.setup(args);
    else if (command === 'deploy') await cloud.update();
    else if (command === 'code') await cloud.code();
    else if (command === 'unlink-desktop') cloud.unlink();
    else throw new Stop(`Unknown command "${command ?? ''}".`, ['Use npm run cloud:setup, cloud:deploy, cloud:code or cloud:unlink-desktop.']);
    return 0;
  } catch (e) {
    ctx.print('');
    ctx.print(`[STOP] ${(e as Error).message}`);
    if (e instanceof Stop) for (const f of e.fix) ctx.print(`       ${f}`);
    ctx.print('');
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  process.exitCode = await runCloud(command, args);
}
