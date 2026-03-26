/**
 * ihub stop — Stop a running iHub server instance
 * Usage: ihub stop [--port <port>]
 */
import { readFileSync, existsSync, unlinkSync } from 'fs';
import { c, symbols } from '../utils/colors.js';
import { getPidFile } from '../utils/paths.js';
import { checkHealth, parseServerArgs } from '../utils/api.js';

const HELP = `
  ${c.bold('ihub stop')} — Stop a running iHub server instance

  ${c.bold('Usage:')}
    ihub stop [options]

  ${c.bold('Options:')}
    --port <port>    Port to check server health on (default: 3000)
    --force          Send SIGKILL instead of SIGTERM
    -h, --help       Show this help

  ${c.bold('Notes:')}
    Works with servers started using 'ihub start --daemon'.
    For foreground servers, press Ctrl+C in the terminal.
`;

export default async function stop(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }

  const force = args.includes('--force');
  const { port } = parseServerArgs(args);
  const pidFile = getPidFile();
  const signal = force ? 'SIGKILL' : 'SIGTERM';

  if (!existsSync(pidFile)) {
    // Try checking if server is running on the port without a PID file
    const health = await checkHealth(port);
    if (!health) {
      console.log(`${symbols.info} No running iHub server found.`);
      console.log(
        `  If a server is running, try stopping it manually or use ${c.cyan('ihub start --daemon')} next time.`
      );
    } else {
      console.error(`${symbols.error} Server is running on port ${port} but no PID file found.`);
      console.error(`  PID file location: ${pidFile}`);
      console.error(`  Stop it manually by finding the process listening on port ${port}.`);
      process.exit(1);
    }
    return;
  }

  const pidStr = readFileSync(pidFile, 'utf-8').trim();
  const pid = parseInt(pidStr, 10);

  if (isNaN(pid)) {
    console.error(`${symbols.error} Invalid PID in file: ${pidFile}`);
    unlinkSync(pidFile);
    process.exit(1);
  }

  try {
    process.kill(pid, 0); // Check if process exists
  } catch {
    console.log(`${symbols.warning} No process found with PID ${pid}. Cleaning up stale PID file.`);
    unlinkSync(pidFile);
    return;
  }

  console.log(`${symbols.info} Stopping iHub server (PID: ${pid})...`);

  try {
    process.kill(pid, signal);

    // Wait briefly for process to die before checking health and removing PID file
    let attempts = 0;
    let processDead = false;
    while (attempts < 20) {
      await new Promise(r => setTimeout(r, 250));
      try {
        process.kill(pid, 0);
        attempts++;
      } catch {
        processDead = true;
        break; // Process is gone
      }
    }

    // Use the parsed host for health check to match the server bind address
    const { host } = parseServerArgs(args);
    const health = await checkHealth(port, host);

    if (health) {
      if (!force) {
        console.error(`${symbols.error} Server is still responding on port ${port}. Try --force.`);
        process.exit(1);
      } else {
        console.error(`${symbols.error} Server did not stop after SIGKILL.`);
        process.exit(1);
      }
    }

    // Only remove PID file after confirming the process is dead and server is not responding
    if (processDead && !health && existsSync(pidFile)) {
      unlinkSync(pidFile);
    }

    console.log(`${symbols.success} Server stopped.`);
  } catch (err) {
    console.error(`${symbols.error} Failed to stop server:`, err.message);
    process.exit(1);
  }
}
