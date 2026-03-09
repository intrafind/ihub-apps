/**
 * ihub apps — Manage AI applications
 * Usage: ihub apps <subcommand> [options]
 * Subcommands: list, add, enable, disable
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { c, symbols } from '../utils/colors.js';
import { getContentsDir, getDefaultsDir } from '../utils/paths.js';

const HELP = `
  ${c.bold('ihub apps')} — Manage AI applications

  ${c.bold('Usage:')}
    ihub apps <subcommand> [options]

  ${c.bold('Subcommands:')}
    list                      Show all configured apps
    add                       Interactive app creation wizard
    enable <id>               Enable a disabled app
    disable <id>              Disable an app

  ${c.bold('Options:')}
    --json                    Output list as JSON (for 'list')
    -h, --help                Show this help

  ${c.bold('Examples:')}
    ihub apps list
    ihub apps enable code-assistant
    ihub apps disable legacy-bot
`;

function loadApps() {
  const contentsDir = getContentsDir();
  const defaultsDir = getDefaultsDir();

  const appsDir = existsSync(path.join(contentsDir, 'apps'))
    ? path.join(contentsDir, 'apps')
    : path.join(defaultsDir, 'apps');

  if (!existsSync(appsDir)) return [];

  const apps = [];
  for (const file of readdirSync(appsDir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const data = JSON.parse(readFileSync(path.join(appsDir, file), 'utf-8'));
      apps.push({ ...data, _file: path.join(appsDir, file) });
    } catch {}
  }

  return apps.sort((a, b) => (a.order || 999) - (b.order || 999));
}

function getAppName(app) {
  if (typeof app.name === 'string') return app.name;
  return app.name?.en || app.name?.de || app.id || 'unknown';
}

function getAppModel(app) {
  return app.preferredModel || c.gray('(not set)');
}

async function listApps(args) {
  const asJson = args.includes('--json');
  const apps = loadApps();

  if (apps.length === 0) {
    console.log(`${symbols.info} No apps configured.`);
    console.log(`  Run ${c.cyan('ihub apps add')} to create one.`);
    return;
  }

  if (asJson) {
    console.log(JSON.stringify(apps.map(a => ({
      id: a.id,
      name: getAppName(a),
      model: a.preferredModel,
      enabled: a.enabled !== false,
      category: a.category
    })), null, 2));
    return;
  }

  console.log('');
  console.log(`  ${c.bold(`Apps (${apps.length} total)`)}`);
  console.log(`  ${c.gray('─'.repeat(60))}`);

  const enabledApps = apps.filter(a => a.enabled !== false);
  const disabledApps = apps.filter(a => a.enabled === false);

  const printApp = app => {
    const enabled = app.enabled !== false;
    const statusIcon = enabled ? symbols.success : c.gray('○');
    const name = enabled ? c.white(getAppName(app)) : c.gray(getAppName(app));
    const id = c.gray(app.id || '—');
    const model = c.gray(getAppModel(app));
    const category = app.category ? c.gray(` [${app.category}]`) : '';
    console.log(`  ${statusIcon} ${name}${category}`);
    console.log(`     ${c.gray('id:')} ${id}  ${c.gray('model:')} ${model}`);
  };

  if (enabledApps.length > 0) {
    console.log(`  ${c.green('Enabled')} (${enabledApps.length})`);
    enabledApps.forEach(printApp);
  }

  if (disabledApps.length > 0) {
    console.log('');
    console.log(`  ${c.gray('Disabled')} (${disabledApps.length})`);
    disabledApps.forEach(printApp);
  }

  console.log('');
  console.log(`  ${c.gray('Tip:')} Use ${c.cyan('ihub apps enable <id>')} or ${c.cyan('disable <id>')} to change status.`);
  console.log('');
}

async function setAppEnabled(id, enabled) {
  const contentsDir = getContentsDir();
  const appsDir = path.join(contentsDir, 'apps');

  if (!existsSync(appsDir)) {
    console.error(`${symbols.error} Apps directory not found at: ${appsDir}`);
    console.error(`  Run ${c.cyan('ihub start')} first to initialize configuration.`);
    process.exit(1);
  }

  const file = path.join(appsDir, `${id}.json`);
  if (!existsSync(file)) {
    // Search by id field
    const allFiles = readdirSync(appsDir).filter(f => f.endsWith('.json'));
    const found = allFiles.find(f => {
      try {
        return JSON.parse(readFileSync(path.join(appsDir, f), 'utf-8')).id === id;
      } catch {
        return false;
      }
    });

    if (!found) {
      console.error(`${symbols.error} App not found: ${c.bold(id)}`);
      console.error(`  Run ${c.cyan('ihub apps list')} to see available apps.`);
      process.exit(1);
    }

    const appPath = path.join(appsDir, found);
    const app = JSON.parse(readFileSync(appPath, 'utf-8'));
    app.enabled = enabled;
    writeFileSync(appPath, JSON.stringify(app, null, 2) + '\n', 'utf-8');
    const action = enabled ? c.green('enabled') : c.gray('disabled');
    console.log(`${symbols.success} App ${c.bold(getAppName(app))} ${action}`);
    return;
  }

  const app = JSON.parse(readFileSync(file, 'utf-8'));
  app.enabled = enabled;
  writeFileSync(file, JSON.stringify(app, null, 2) + '\n', 'utf-8');
  const action = enabled ? c.green('enabled') : c.gray('disabled');
  console.log(`${symbols.success} App ${c.bold(getAppName(app))} ${action}`);
}

async function addApp(args) {
  let clack;
  try {
    clack = await import('@clack/prompts');
  } catch {
    console.error(`${symbols.error} @clack/prompts not installed. Run: npm install`);
    process.exit(1);
  }

  const { intro, outro, text, select, confirm, isCancel, cancel } = clack;

  intro(c.bold(' Create a new App '));

  const id = await text({
    message: 'App ID (unique identifier):',
    placeholder: 'my-assistant',
    validate: val => {
      if (!val) return 'ID is required';
      if (!/^[a-z0-9-]+$/.test(val)) return 'Use only lowercase letters, numbers, and hyphens';
      if (val.length > 50) return 'ID must be 50 characters or less';
    }
  });
  if (isCancel(id)) { cancel('Cancelled.'); return; }

  const name = await text({
    message: 'App name:',
    placeholder: 'My Assistant',
    validate: val => { if (!val) return 'Name is required'; }
  });
  if (isCancel(name)) { cancel('Cancelled.'); return; }

  const description = await text({
    message: 'Short description:',
    placeholder: 'A helpful AI assistant'
  });
  if (isCancel(description)) { cancel('Cancelled.'); return; }

  const model = await text({
    message: 'Preferred model (optional):',
    placeholder: 'gpt-4o'
  });
  if (isCancel(model)) { cancel('Cancelled.'); return; }

  const systemPrompt = await text({
    message: 'System prompt:',
    placeholder: 'You are a helpful assistant.',
    validate: val => { if (!val) return 'System prompt is required'; }
  });
  if (isCancel(systemPrompt)) { cancel('Cancelled.'); return; }

  const color = await text({
    message: 'Accent color (hex):',
    initialValue: '#4F46E5',
    validate: val => {
      if (!/^#[0-9A-Fa-f]{6}$/.test(val)) return 'Enter a valid hex color like #4F46E5';
    }
  });
  if (isCancel(color)) { cancel('Cancelled.'); return; }

  const appConfig = {
    id: id.trim(),
    name: { en: name.trim() },
    description: { en: (description || '').trim() },
    color: color.trim(),
    icon: 'robot',
    system: { en: systemPrompt.trim() },
    tokenLimit: 4096,
    enabled: true,
    ...(model && model.trim() ? { preferredModel: model.trim() } : {})
  };

  const contentsDir = getContentsDir();
  const appsDir = path.join(contentsDir, 'apps');

  if (!existsSync(appsDir)) {
    console.error(`${symbols.error} Apps directory not found. Run ${c.cyan('ihub start')} first.`);
    cancel('');
    return;
  }

  const outFile = path.join(appsDir, `${id}.json`);
  if (existsSync(outFile)) {
    const overwrite = await confirm({ message: `App '${id}' already exists. Overwrite?` });
    if (isCancel(overwrite) || !overwrite) { cancel('Cancelled.'); return; }
  }

  writeFileSync(outFile, JSON.stringify(appConfig, null, 2) + '\n', 'utf-8');
  outro(`${c.green('App created!')} ${c.gray(outFile)}`);
}

export default async function apps(args) {
  const [subcommand, ...rest] = args;

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(HELP);
    return;
  }

  switch (subcommand) {
    case 'list':
      await listApps(rest);
      break;
    case 'add':
      await addApp(rest);
      break;
    case 'enable': {
      const id = rest[0];
      if (!id) {
        console.error(`${symbols.error} Usage: ihub apps enable <id>`);
        process.exit(1);
      }
      await setAppEnabled(id, true);
      break;
    }
    case 'disable': {
      const id = rest[0];
      if (!id) {
        console.error(`${symbols.error} Usage: ihub apps disable <id>`);
        process.exit(1);
      }
      await setAppEnabled(id, false);
      break;
    }
    default:
      console.error(`${symbols.error} Unknown subcommand: ${subcommand}`);
      console.error(`  Run ${c.cyan('ihub apps --help')} for usage.`);
      process.exit(1);
  }
}
