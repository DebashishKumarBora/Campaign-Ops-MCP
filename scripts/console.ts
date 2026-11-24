/**
 * npm run console
 * Opens the approval console in your browser with your key. If an MCP client
 * is already running Campaign Ops, it reuses that console; otherwise it starts
 * a standalone one that shares the same data folder.
 */
import { spawn } from 'node:child_process';
import { createApp } from '../src/app.js';
import { startConsole, consoleIsRunning } from '../src/console/server.js';

function openInBrowser(url: string): void {
  try {
    const child =
      process.platform === 'win32'
        ? spawn('cmd', ['/c', 'start', '""', `"${url}"`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true })
        : process.platform === 'darwin'
          ? spawn('open', [url], { detached: true, stdio: 'ignore' })
          : spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // printing the link is enough
  }
}

const app = createApp();
const port = app.config.consolePort > 0 ? app.config.consolePort : 4848;
const noOpen = process.argv.includes('--no-open');
const link = (p: number) => `http://127.0.0.1:${p}/#key=${app.config.consoleToken}`;

if (await consoleIsRunning(port)) {
  console.log('\nThe approval console is already running.');
  console.log(`Open: ${link(port)}\n`);
  if (!noOpen) openInBrowser(link(port));
  process.exit(0);
}

const handle = await startConsole({ engine: app.engine, backend: app.backend, token: app.config.consoleToken, port, uiDir: app.uiDir, version: app.version });
console.log('\nCampaign Ops approval console is running.');
console.log(`Open: ${handle.urlWithKey}`);
console.log('The link contains your console key. Do not share it.');
console.log('Keep this window open while you review changes. Press Ctrl+C to stop.\n');
if (!noOpen) openInBrowser(handle.urlWithKey);

const stop = async () => {
  await handle.close();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
