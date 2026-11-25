#!/usr/bin/env node
/**
 * Campaign Ops MCP server (stdio).
 * MCP clients start this process and talk to it over stdin and stdout, so
 * nothing here may write to stdout. Logs go to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createApp } from './app.js';
import { createMcpServer } from './server.js';
import { startConsole, consoleIsRunning, type ConsoleHandle } from './console/server.js';

const log = (...args: unknown[]) => console.error('[campaign-ops]', ...args);

async function main(): Promise<void> {
  const app = createApp();
  const { config } = app;

  let consoleHandle: ConsoleHandle | undefined;
  let consoleUrl: string | undefined;
  if (config.consolePort > 0) {
    try {
      consoleHandle = await startConsole({ engine: app.engine, backend: app.backend, token: config.consoleToken, port: config.consolePort, uiDir: app.uiDir, version: app.version });
      consoleUrl = consoleHandle.url;
      log(`Approval console: ${consoleHandle.url} (run "npm run console" to open it with your key)`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE' && (await consoleIsRunning(config.consolePort))) {
        consoleUrl = `http://127.0.0.1:${config.consolePort}/`;
        log(`Approval console already running at ${consoleUrl} (another Campaign Ops process). Sharing it.`);
      } else {
        log(`Approval console could not start on port ${config.consolePort}: ${(e as Error).message}`);
      }
    }
  }

  const mcp = createMcpServer({ engine: app.engine, backend: app.backend, config, version: app.version, consoleUrl: () => consoleUrl });

  let closing = false;
  const shutdown = async (code = 0) => {
    if (closing) return;
    closing = true;
    try {
      await consoleHandle?.close();
      await mcp.close();
    } finally {
      process.exit(code);
    }
  };

  mcp.server.onclose = () => void shutdown(0);
  process.stdin.on('end', () => void shutdown(0));
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));

  await mcp.connect(new StdioServerTransport());
  log(`Ready. Mode: ${app.backend.mode}. Scope: ${config.scope}. Policy: ${config.policySource}. Data: ${config.dataDir}`);
  log(app.googleAdsStatus.message);
}

main().catch((e) => {
  log('Failed to start:', (e as Error).message);
  process.exit(1);
});
