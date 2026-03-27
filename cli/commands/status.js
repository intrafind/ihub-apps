/**
 * ihub status — Show server version, uptime, and health
 * Usage: ihub status [--port <port>] [--host <host>]
 */
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { c, symbols } from '../utils/colors.js';
import { checkHealth, parseServerArgs, getServerUrl } from '../utils/api.js';
import { getPidFile, getRootDir } from '../utils/paths.js';

const HELP = `
  ${c.bold('ihub status')} — Show server version, uptime, and health

  ${c.bold('Usage:')}
    ihub status [options]

  ${c.bold('Options:')}
    --port <port>    Port to check (default: 3000)
    --host <host>    Host to check (default: localhost)
    --json           Output as JSON
    -h, --help       Show this help
`;

function formatUptime(seconds) {
  if (!seconds) return 'unknown';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

function formatBytes(bytes) {
  if (!bytes) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB'];
  let val = bytes;
  let unit = 0;
  while (val >= 1024 && unit < units.length - 1) {
    val /= 1024;
    unit++;
  }
  return `${val.toFixed(1)} ${units[unit]}`;
}

export default async function status(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }

  const { port, host } = parseServerArgs(args);
  const asJson = args.includes('--json');

  // Get package version
  const pkgPath = path.join(getRootDir(), 'package.json');
  let version = 'unknown';
  if (existsSync(pkgPath)) {
    try {
      version = JSON.parse(readFileSync(pkgPath, 'utf-8')).version;
    } catch {}
  }

  // Check PID file
  const pidFile = getPidFile();
  const pid = existsSync(pidFile) ? readFileSync(pidFile, 'utf-8').trim() : null;

  // Check server health
  const health = await checkHealth(port, host);
  const running = health !== null;
  const url = getServerUrl(port, host);

  if (asJson) {
    const output = {
      version,
      running,
      url: running ? url : null,
      pid: pid ? parseInt(pid) : null,
      health: health || null
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log('');
  console.log(`  ${c.bold('iHub Apps')} v${version}`);
  console.log(`  ${c.gray('─'.repeat(40))}`);
  console.log(
    `  Status:    ${running ? `${symbols.success} ${c.green('Running')}` : `${symbols.error} ${c.red('Stopped')}`}`
  );
  console.log(`  URL:       ${running ? c.cyan(url) : c.gray('—')}`);

  if (pid) {
    console.log(`  PID:       ${c.gray(pid)}`);
  }

  if (health) {
    if (health.uptime !== undefined) {
      console.log(`  Uptime:    ${c.white(formatUptime(health.uptime))}`);
    }
    if (health.memory) {
      const mem = health.memory;
      console.log(
        `  Memory:    ${c.white(formatBytes(mem.heapUsed))} / ${formatBytes(mem.heapTotal)}`
      );
    }
    if (health.version) {
      console.log(`  Node.js:   ${c.gray(health.version)}`);
    }
    if (health.environment) {
      console.log(`  Env:       ${c.gray(health.environment)}`);
    }
  }

  console.log('');

  if (!running) {
    console.log(`  Run ${c.cyan('ihub start')} to start the server.`);
    console.log('');
  }
}
