/**
 * ihub CLI — Main entry point and command dispatcher
 *
 * Usage: ihub <command> [subcommand] [options]
 */
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { c, symbols } from './utils/colors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getVersion() {
  const pkgPath = path.join(__dirname, '..', 'package.json');
  if (existsSync(pkgPath)) {
    try {
      return JSON.parse(readFileSync(pkgPath, 'utf-8')).version;
    } catch {}
  }
  return 'unknown';
}

const VERSION = getVersion();

const HELP = `
  ${c.bold('ihub')} v${VERSION} — iHub Apps CLI

  ${c.bold('Usage:')}
    ihub <command> [subcommand] [options]

  ${c.bold('Lifecycle:')}
    start              Start the server
    stop               Stop a running instance
    status             Show version, uptime, and health
    doctor             Diagnose configuration, ports, API keys
    open               Open the browser to the running instance
    setup              Interactive first-run wizard
    update             Check for and apply updates

  ${c.bold('App Management:')}
    apps list          Show configured apps
    apps add           Interactive app creation wizard
    apps enable <id>   Enable a disabled app
    apps disable <id>  Disable an app

  ${c.bold('Model Management:')}
    models list        Show configured models (name, provider, key status)
    models add         Interactive model addition wizard
    models test [id]   Test model connectivity

  ${c.bold('Configuration:')}
    config show [name] Print current config (or a specific config file)
    config edit [name] Open config in $EDITOR
    config reset [name] Reset configuration to defaults

  ${c.bold('Data Management:')}
    logs               Stream server logs (--level error, --lines 50)
    backup             Archive contents/ directory with timestamp
    restore <file>     Restore from a backup archive

  ${c.bold('Other:')}
    completions <shell> Generate shell completions (bash|zsh|fish|powershell)

  ${c.bold('Global Options:')}
    -h, --help         Show help (also: ihub <command> --help)
    -v, --version      Show version
    --port <port>      Server port (default: $PORT or 3000)
    --host <host>      Server host (default: $HOST or localhost)

  ${c.bold('Examples:')}
    ihub start
    ihub status
    ihub doctor
    ihub apps list
    ihub models list
    ihub backup
    ihub completions bash >> ~/.bashrc
`;

const COMMAND_MAP = {
  start: './commands/start.js',
  stop: './commands/stop.js',
  status: './commands/status.js',
  doctor: './commands/doctor.js',
  open: './commands/open.js',
  setup: './commands/setup.js',
  update: './commands/update.js',
  apps: './commands/apps.js',
  models: './commands/models.js',
  config: './commands/config.js',
  logs: './commands/logs.js',
  backup: './commands/backup.js',
  restore: './commands/restore.js',
  completions: './commands/completions.js'
};

async function main() {
  const args = process.argv.slice(2);

  if (!args.length || args[0] === '--help' || args[0] === '-h') {
    console.log(HELP);
    process.exit(0);
  }

  if (args[0] === '--version' || args[0] === '-v') {
    console.log(`ihub ${VERSION}`);
    process.exit(0);
  }

  const [noun, ...rest] = args;
  const commandPath = COMMAND_MAP[noun];

  if (!commandPath) {
    console.error(`${symbols.error} Unknown command: ${c.bold(noun)}`);
    console.error(`  Run ${c.cyan('ihub --help')} for a list of available commands.`);
    process.exit(1);
  }

  try {
    const moduleUrl = new URL(commandPath, import.meta.url).href;
    const { default: command } = await import(moduleUrl);
    await command(rest);
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND' && err.message.includes('@clack/prompts')) {
      console.error(`${symbols.error} Missing dependency: ${c.bold('@clack/prompts')}`);
      console.error(`  Run: ${c.cyan('npm install')} to install all dependencies.`);
    } else {
      console.error(`${symbols.error} Command failed: ${err.message}`);
      if (process.env.DEBUG) console.error(err.stack);
    }
    process.exit(1);
  }
}

main();
