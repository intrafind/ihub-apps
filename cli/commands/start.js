/**
 * ihub start — Start the iHub server
 * Usage: ihub start [--port <port>] [--host <host>] [--daemon]
 */
import { spawn } from 'child_process';
import { writeFileSync, existsSync } from 'fs';
import path from 'path';
import { getRootDir, getPidFile, getEnvFile } from '../utils/paths.js';
import { c, symbols } from '../utils/colors.js';
import { parseServerArgs, isPortAvailable } from '../utils/api.js';

const HELP = `
  ${c.bold('ihub start')} — Start the iHub server

  ${c.bold('Usage:')}
    ihub start [options]

  ${c.bold('Options:')}
    --port <port>    Port to listen on (default: 3000, or $PORT)
    --host <host>    Host to bind to (default: 0.0.0.0, or $HOST)
    --daemon         Run in background and write PID file
    -h, --help       Show this help

  ${c.bold('Examples:')}
    ihub start
    ihub start --port 8080
    ihub start --daemon
`;

export default async function start(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }

  const { port, host } = parseServerArgs(args);
  const daemon = args.includes('--daemon');
  const rootDir = getRootDir();
  const serverScript = path.join(rootDir, 'server', 'server.js');
  const envFile = getEnvFile();

  if (!existsSync(serverScript)) {
    console.error(`${symbols.error} Server not found at: ${serverScript}`);
    console.error(`  Make sure you are running this from the iHub Apps directory.`);
    process.exit(1);
  }

  // Check port availability
  const portFree = await isPortAvailable(port);
  if (!portFree) {
    console.error(`${symbols.error} Port ${port} is already in use.`);
    console.error(`  Use --port <port> to specify a different port, or stop the existing process.`);
    process.exit(1);
  }

  console.log(`${symbols.info} Starting iHub Apps server...`);
  console.log(`  ${c.gray('Root:')}    ${rootDir}`);
  console.log(`  ${c.gray('Port:')}    ${port}`);
  console.log(`  ${c.gray('Mode:')}    ${daemon ? 'daemon' : 'foreground'}`);

  const nodeArgs = ['-r', 'dotenv/config', serverScript, `dotenv_config_path=${envFile}`];
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: host
  };

  if (daemon) {
    const child = spawn(process.execPath, nodeArgs, {
      cwd: rootDir,
      env,
      stdio: 'ignore',
      detached: true
    });
    child.unref();

    const pidFile = getPidFile();
    writeFileSync(pidFile, String(child.pid), 'utf-8');

    console.log(`${symbols.success} Server started in background (PID: ${child.pid})`);
    console.log(`  ${c.gray('PID file:')} ${pidFile}`);
    console.log(`  ${c.gray('URL:')}      http://localhost:${port}`);
    console.log(`  Run ${c.cyan('ihub stop')} to shut it down.`);
  } else {
    console.log(`  ${c.gray('URL:')}     http://localhost:${port}`);
    console.log(`  Press ${c.bold('Ctrl+C')} to stop the server.\n`);

    const child = spawn(process.execPath, nodeArgs, {
      cwd: rootDir,
      env,
      stdio: 'inherit'
    });

    child.on('exit', code => {
      if (code !== 0) {
        console.error(`\n${symbols.error} Server exited with code ${code}`);
        process.exit(code);
      }
    });

    // Forward signals to child
    for (const sig of ['SIGINT', 'SIGTERM']) {
      process.on(sig, () => child.kill(sig));
    }

    await new Promise(resolve => child.on('exit', resolve));
  }
}
