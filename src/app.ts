import path from 'node:path';
import { loadConfig, type AppConfig } from './config.js';
import type { AdsBackend } from './backends/backend.js';
import { SandboxBackend } from './backends/sandbox.js';
import { RouterBackend } from './backends/router.js';
import { loadGoogleAdsBackend, type GoogleAdsBackend, type GoogleAdsStatus } from './backends/googleAds/index.js';
import { Engine } from './governance/engine.js';
import { appVersion } from './util/root.js';

export interface App {
  config: AppConfig;
  /** Every connected account: the sandbox, plus a Google Ads test account once npm run gads:setup has run. */
  backend: AdsBackend;
  sandbox: SandboxBackend;
  googleAds?: GoogleAdsBackend;
  googleAdsStatus: { status: GoogleAdsStatus; message: string };
  engine: Engine;
  version: string;
  uiDir: string;
}

/** Wires config, backends and engine together. Shared by the MCP server and the scripts. */
export function createApp(env: NodeJS.ProcessEnv = process.env): App {
  const config = loadConfig(env);
  const sandbox = new SandboxBackend(path.join(config.dataDir, 'sandbox.json'));
  sandbox.ensure();
  const google = loadGoogleAdsBackend(env);
  const parts: AdsBackend[] = [sandbox];
  if (google.backend) parts.push(google.backend);
  const backend = new RouterBackend(parts);
  const engine = new Engine({ backend, dataDir: config.dataDir, policy: config.policy, scope: config.scope, forceKillSwitch: config.forceKillSwitch });
  return {
    config,
    backend,
    sandbox,
    googleAds: google.backend,
    googleAdsStatus: { status: google.status, message: google.message },
    engine,
    version: appVersion(),
    uiDir: path.join(config.root, 'console-ui'),
  };
}
