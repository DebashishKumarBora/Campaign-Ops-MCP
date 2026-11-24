import path from 'node:path';
import { loadConfig, type AppConfig } from './config.js';
import { SandboxBackend } from './backends/sandbox.js';
import { Engine } from './governance/engine.js';
import { appVersion } from './util/root.js';

export interface App {
  config: AppConfig;
  backend: SandboxBackend;
  engine: Engine;
  version: string;
  uiDir: string;
}

/** Wires config, backend and engine together. Shared by the MCP server and the scripts. */
export function createApp(env: NodeJS.ProcessEnv = process.env): App {
  const config = loadConfig(env);
  const backend = new SandboxBackend(path.join(config.dataDir, 'sandbox.json'));
  backend.ensure();
  const engine = new Engine({ backend, dataDir: config.dataDir, policy: config.policy, scope: config.scope, forceKillSwitch: config.forceKillSwitch });
  return { config, backend, engine, version: appVersion(), uiDir: path.join(config.root, 'console-ui') };
}
