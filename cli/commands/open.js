/**
 * ihub open — Open the iHub interface in a browser
 * Usage: ihub open [--port <port>]
 */
import { spawn } from 'child_process';
import { c, symbols } from '../utils/colors.js';
import { checkHealth, parseServerArgs, getServerUrl } from '../utils/api.js';

const HELP = `
  ${c.bold('ihub open')} — Open the iHub interface in a browser

  ${c.bold('Usage:')}
    ihub open [options]

  ${c.bold('Options:')}
    --port <port>    Port to open (default: 3000)
    --host <host>    Host to open (default: localhost)
    --no-check       Skip server health check before opening
    -h, --help       Show this help
`;

function openBrowser(url) {
  const platform = process.platform;
  let command, args;

  if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    // Linux — try common browser openers
    command = 'xdg-open';
    args = [url];
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'ignore',
      detached: true,
      shell: false
    });

    child.on('error', err => {
      // Try fallback on Linux
      if (platform === 'linux' && command === 'xdg-open') {
        const fallback = spawn('sensible-browser', [url], {
          stdio: 'ignore',
          detached: true,
          shell: false
        });
        fallback.on('error', reject);
        fallback.unref();
        resolve();
      } else {
        reject(err);
      }
    });

    child.unref();
    resolve();
  });
}

export default async function open(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }

  const { port, host } = parseServerArgs(args);
  const noCheck = args.includes('--no-check');
  const url = getServerUrl(port, host);

  if (!noCheck) {
    const health = await checkHealth(port, host);
    if (!health) {
      console.error(`${symbols.error} Server is not running on ${url}`);
      console.error(`  Start it first with: ${c.cyan('ihub start')}`);
      process.exit(1);
    }
  }

  try {
    await openBrowser(url);
    console.log(`${symbols.success} Opened ${c.cyan(url)} in browser`);
  } catch (err) {
    console.error(`${symbols.error} Failed to open browser: ${err.message}`);
    console.error(`  Open manually: ${c.cyan(url)}`);
    process.exit(1);
  }
}
