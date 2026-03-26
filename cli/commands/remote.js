/**
 * ihub remote — Manage remote iHub instances
 * Usage: ihub remote <subcommand> [options]
 * Subcommands: add, list, remove, set-default, test
 */
import { c, symbols } from '../utils/colors.js';
import {
  loadRemoteConfig,
  saveRemoteConfig,
  checkRemoteHealth,
  getDisplayUrl
} from '../utils/remote-api.js';

const HELP = `
  ${c.bold('ihub remote')} — Manage remote iHub server instances

  ${c.bold('Usage:')}
    ihub remote <subcommand> [options]

  ${c.bold('Subcommands:')}
    add <name> <url>     Add a new remote instance
    list                 List all configured remote instances
    remove <name>        Remove a remote instance
    set-default <name>   Set the default remote instance
    test <name>          Test connection to a remote instance

  ${c.bold('Options (for "add"):')}
    --token <token>      Authentication token (JWT or API key)
    --no-ssl-verify      Skip SSL certificate verification (not recommended)

  ${c.bold('Examples:')}
    ihub remote add prod https://ihub.example.com --token abc123
    ihub remote add staging https://staging.example.com:8443 --no-ssl-verify
    ihub remote list
    ihub remote set-default prod
    ihub remote test prod
    ihub remote remove staging
`;

async function addRemote(args) {
  if (args.length < 2) {
    console.error(`${symbols.error} Usage: ihub remote add <name> <url> [--token <token>] [--no-ssl-verify]`);
    process.exit(1);
  }

  const name = args[0];
  const url = args[1];
  let token = null;
  let sslVerify = true;

  // Parse additional options
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--token' && args[i + 1]) {
      token = args[i + 1];
      i++;
    } else if (args[i].startsWith('--token=')) {
      token = args[i].split('=')[1];
    } else if (args[i] === '--no-ssl-verify') {
      sslVerify = false;
    }
  }

  // Validate URL
  try {
    new URL(url);
  } catch {
    console.error(`${symbols.error} Invalid URL: ${url}`);
    process.exit(1);
  }

  // Test connection
  console.log(`${symbols.info} Testing connection to ${c.cyan(getDisplayUrl(url))}...`);
  const health = await checkRemoteHealth(url, { token, sslVerify, timeout: 10000 });

  if (!health) {
    console.error(`${symbols.error} Failed to connect to ${url}`);
    console.error(`  Make sure the server is running and the URL is correct.`);

    let clack;
    try {
      clack = await import('@clack/prompts');
    } catch {}

    if (clack) {
      const { confirm, isCancel } = clack;
      const proceed = await confirm({
        message: 'Save instance anyway?',
        initialValue: false
      });

      if (isCancel(proceed) || !proceed) {
        process.exit(1);
      }
    } else {
      console.error(`  Add --force to save anyway (requires @clack/prompts for interactive prompt)`);
      process.exit(1);
    }
  } else {
    console.log(`${symbols.success} Connection successful`);
    console.log(`  ${c.gray('Version:')} ${health.version || 'unknown'}`);
    console.log(`  ${c.gray('Status:')}  ${health.status}`);
  }

  // Load existing config
  const config = loadRemoteConfig();

  // Add new instance
  config.instances[name] = {
    url,
    token,
    sslVerify,
    addedAt: new Date().toISOString()
  };

  // Set as default if it's the first instance
  if (!config.defaultInstance) {
    config.defaultInstance = name;
    console.log(`${symbols.info} Set as default instance`);
  }

  // Save config
  saveRemoteConfig(config);

  console.log(`${symbols.success} Added remote instance: ${c.cyan(name)}`);
  console.log(`  ${c.gray('URL:')} ${getDisplayUrl(url)}`);
  console.log('');
  console.log(`  Use ${c.cyan('--instance ' + name)} or ${c.cyan('--url ' + url)} to connect to this instance`);
}

async function listRemotes() {
  const config = loadRemoteConfig();

  if (Object.keys(config.instances).length === 0) {
    console.log(`${symbols.info} No remote instances configured`);
    console.log(`  Add one with: ${c.cyan('ihub remote add <name> <url>')}`);
    return;
  }

  console.log('');
  console.log(`  ${c.bold('Configured Remote Instances')}`);
  console.log(`  ${c.gray('─'.repeat(60))}`);
  console.log('');

  for (const [name, instance] of Object.entries(config.instances)) {
    const isDefault = name === config.defaultInstance;
    const marker = isDefault ? `${symbols.success} ${c.cyan(name)} ${c.gray('(default)')}` : `  ${c.white(name)}`;

    console.log(`  ${marker}`);
    console.log(`    ${c.gray('URL:')}        ${getDisplayUrl(instance.url)}`);
    console.log(`    ${c.gray('SSL Verify:')} ${instance.sslVerify !== false ? 'yes' : c.yellow('no')}`);
    console.log(`    ${c.gray('Token:')}      ${instance.token ? '***' + instance.token.slice(-4) : c.gray('(none)')}`);
    console.log(`    ${c.gray('Added:')}      ${new Date(instance.addedAt).toLocaleString()}`);
    console.log('');
  }

  console.log(`  Use ${c.cyan('ihub remote test <name>')} to test connection`);
  console.log('');
}

async function removeRemote(args) {
  if (args.length === 0) {
    console.error(`${symbols.error} Usage: ihub remote remove <name>`);
    process.exit(1);
  }

  const name = args[0];
  const config = loadRemoteConfig();

  if (!config.instances[name]) {
    console.error(`${symbols.error} Remote instance not found: ${name}`);
    console.error(`  Available instances: ${Object.keys(config.instances).join(', ') || '(none)'}`);
    process.exit(1);
  }

  // Confirm removal
  let clack;
  try {
    clack = await import('@clack/prompts');
  } catch {}

  if (clack) {
    const { confirm, isCancel, cancel } = clack;
    const proceed = await confirm({
      message: `Remove remote instance "${name}"?`,
      initialValue: false
    });

    if (isCancel(proceed) || !proceed) {
      cancel('Cancelled');
      return;
    }
  }

  // Remove instance
  delete config.instances[name];

  // Clear default if it was the default
  if (config.defaultInstance === name) {
    config.defaultInstance = null;

    // If there are other instances, suggest setting a new default
    const remaining = Object.keys(config.instances);
    if (remaining.length > 0) {
      console.log(`${symbols.info} Cleared default instance`);
      console.log(`  Set a new default with: ${c.cyan('ihub remote set-default ' + remaining[0])}`);
    }
  }

  saveRemoteConfig(config);
  console.log(`${symbols.success} Removed remote instance: ${c.cyan(name)}`);
}

async function setDefault(args) {
  if (args.length === 0) {
    console.error(`${symbols.error} Usage: ihub remote set-default <name>`);
    process.exit(1);
  }

  const name = args[0];
  const config = loadRemoteConfig();

  if (!config.instances[name]) {
    console.error(`${symbols.error} Remote instance not found: ${name}`);
    console.error(`  Available instances: ${Object.keys(config.instances).join(', ') || '(none)'}`);
    process.exit(1);
  }

  config.defaultInstance = name;
  saveRemoteConfig(config);

  console.log(`${symbols.success} Set default remote instance: ${c.cyan(name)}`);
  console.log(`  ${c.gray('URL:')} ${getDisplayUrl(config.instances[name].url)}`);
}

async function testRemote(args) {
  if (args.length === 0) {
    console.error(`${symbols.error} Usage: ihub remote test <name>`);
    process.exit(1);
  }

  const name = args[0];
  const config = loadRemoteConfig();
  const instance = config.instances[name];

  if (!instance) {
    console.error(`${symbols.error} Remote instance not found: ${name}`);
    console.error(`  Available instances: ${Object.keys(config.instances).join(', ') || '(none)'}`);
    process.exit(1);
  }

  console.log(`${symbols.info} Testing connection to ${c.cyan(name)}...`);
  console.log(`  ${c.gray('URL:')} ${getDisplayUrl(instance.url)}`);

  const health = await checkRemoteHealth(instance.url, {
    token: instance.token,
    sslVerify: instance.sslVerify !== false,
    timeout: 10000
  });

  if (!health) {
    console.error(`${symbols.error} Failed to connect`);
    console.error(`  Make sure the server is running and accessible`);
    process.exit(1);
  }

  console.log(`${symbols.success} Connection successful`);
  console.log('');
  console.log(`  ${c.gray('Status:')}  ${health.status}`);
  console.log(`  ${c.gray('Version:')} ${health.version || 'unknown'}`);

  if (health.uptime) {
    const uptimeHours = Math.floor(health.uptime / 3600);
    const uptimeMins = Math.floor((health.uptime % 3600) / 60);
    console.log(`  ${c.gray('Uptime:')}  ${uptimeHours}h ${uptimeMins}m`);
  }

  console.log('');
}

export default async function remote(args) {
  const [subcommand, ...rest] = args;

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(HELP);
    return;
  }

  switch (subcommand) {
    case 'add':
      await addRemote(rest);
      break;
    case 'list':
    case 'ls':
      await listRemotes();
      break;
    case 'remove':
    case 'rm':
      await removeRemote(rest);
      break;
    case 'set-default':
    case 'default':
      await setDefault(rest);
      break;
    case 'test':
      await testRemote(rest);
      break;
    default:
      console.error(`${symbols.error} Unknown subcommand: ${subcommand}`);
      console.error(`  Run ${c.cyan('ihub remote --help')} for usage`);
      process.exit(1);
  }
}
