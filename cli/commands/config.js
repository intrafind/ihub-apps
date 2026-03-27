/**
 * ihub config — Manage iHub configuration
 * Usage: ihub config <subcommand> [options]
 * Subcommands: show, edit, reset
 */
import { existsSync, readFileSync, copyFileSync, readdirSync } from 'fs';
import path from 'path';
import { c, symbols } from '../utils/colors.js';
import { getContentsDir, getDefaultsDir } from '../utils/paths.js';

const HELP = `
  ${c.bold('ihub config')} — Manage iHub configuration

  ${c.bold('Usage:')}
    ihub config <subcommand> [options]

  ${c.bold('Subcommands:')}
    show [key]        Print current configuration (or a specific key)
    edit [file]       Open a config file in \$EDITOR
    reset [file]      Reset configuration to defaults

  ${c.bold('Options:')}
    --json            Output as JSON (for 'show')
    --no-confirm      Skip confirmation prompt (for 'reset')
    -h, --help        Show this help

  ${c.bold('Examples:')}
    ihub config show
    ihub config show platform
    ihub config edit platform
    ihub config reset
`;

const CONFIG_FILES = [
  'config/platform.json',
  'config/groups.json',
  'config/ui.json',
  'config/users.json',
  'config/tools.json',
  'config/sources.json'
];

function loadConfig(file, contentsDir) {
  const filePath = path.join(contentsDir, file);
  const defaultsDir = getDefaultsDir();
  const defaultPath = path.join(defaultsDir, file);

  if (existsSync(filePath)) {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } else if (existsSync(defaultPath)) {
    return JSON.parse(readFileSync(defaultPath, 'utf-8'));
  }
  return null;
}

async function showConfig(args) {
  const asJson = args.includes('--json');
  const key = args.filter(a => !a.startsWith('--'))[0];

  const contentsDir = getContentsDir();
  const defaultsDir = getDefaultsDir();

  if (key) {
    // Show a specific config file
    const fileName = key.includes('.json') ? key : `config/${key}.json`;
    const filePath = existsSync(path.join(contentsDir, fileName))
      ? path.join(contentsDir, fileName)
      : path.join(defaultsDir, fileName);

    if (!existsSync(filePath)) {
      console.error(`${symbols.error} Config file not found: ${fileName}`);
      console.error(
        `  Available: ${CONFIG_FILES.map(f => f.replace('config/', '').replace('.json', '')).join(', ')}`
      );
      process.exit(1);
    }

    const data = JSON.parse(readFileSync(filePath, 'utf-8'));

    if (asJson) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log('');
      console.log(`  ${c.bold(fileName)} ${c.gray('(' + filePath + ')')}`);
      console.log(`  ${c.gray('─'.repeat(50))}`);
      // Pretty print with syntax highlighting
      printJson(data, '  ');
      console.log('');
    }
    return;
  }

  // Show summary of all config
  if (asJson) {
    const allConfig = {};
    for (const file of CONFIG_FILES) {
      const basename = path.basename(file, '.json');
      allConfig[basename] = loadConfig(file, contentsDir);
    }
    console.log(JSON.stringify(allConfig, null, 2));
    return;
  }

  console.log('');
  console.log(`  ${c.bold('iHub Configuration Summary')}`);
  console.log(`  ${c.gray('─'.repeat(50))}`);
  console.log(`  ${c.gray('Contents dir:')} ${contentsDir}`);
  console.log('');

  for (const file of CONFIG_FILES) {
    const filePath = path.join(contentsDir, file);
    const defaultPath = path.join(defaultsDir, file);
    const label = path.basename(file, '.json');

    if (existsSync(filePath)) {
      try {
        const data = JSON.parse(readFileSync(filePath, 'utf-8'));
        const size = Object.keys(data).length;
        console.log(
          `  ${symbols.success} ${c.white(label)} ${c.gray(`(${size} keys — ${filePath})`)}`
        );
      } catch {
        console.log(`  ${symbols.error} ${c.red(label)} ${c.gray('(invalid JSON)')}`);
      }
    } else if (existsSync(defaultPath)) {
      console.log(`  ${c.gray('○')} ${c.gray(label)} ${c.gray('(using defaults)')}`);
    } else {
      console.log(`  ${symbols.warning} ${c.yellow(label)} ${c.gray('(not found)')}`);
    }
  }

  // Count apps and models
  const appsDir = existsSync(path.join(contentsDir, 'apps'))
    ? path.join(contentsDir, 'apps')
    : path.join(defaultsDir, 'apps');
  const modelsDir = existsSync(path.join(contentsDir, 'models'))
    ? path.join(contentsDir, 'models')
    : path.join(defaultsDir, 'models');

  const appCount = existsSync(appsDir)
    ? readdirSync(appsDir).filter(f => f.endsWith('.json')).length
    : 0;
  const modelCount = existsSync(modelsDir)
    ? readdirSync(modelsDir).filter(f => f.endsWith('.json')).length
    : 0;

  console.log('');
  console.log(`  ${c.gray('Apps:')}   ${appCount} configured`);
  console.log(`  ${c.gray('Models:')} ${modelCount} configured`);
  console.log('');
  console.log(`  ${c.gray(`Use 'ihub config show <name>' to view a specific config file.`)}`);
  console.log('');
}

function printJson(obj, indent = '') {
  if (typeof obj !== 'object' || obj === null) {
    console.log(`${indent}${c.yellow(JSON.stringify(obj))}`);
    return;
  }

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      console.log(`${indent}${c.cyan(key)}:`);
      printJson(value, indent + '  ');
    } else if (Array.isArray(value)) {
      console.log(`${indent}${c.cyan(key)}: ${c.gray(`[${value.length} items]`)}`);
    } else if (typeof value === 'string' && value.includes('***')) {
      console.log(`${indent}${c.cyan(key)}: ${c.gray('[redacted]')}`);
    } else {
      const displayValue =
        typeof value === 'string'
          ? c.green(`"${value.length > 60 ? value.slice(0, 60) + '...' : value}"`)
          : c.yellow(String(value));
      console.log(`${indent}${c.cyan(key)}: ${displayValue}`);
    }
  }
}

async function editConfig(args) {
  const key = args.filter(a => !a.startsWith('--'))[0] || 'platform';
  const fileName = key.includes('.json') ? key : `config/${key}.json`;
  const contentsDir = getContentsDir();
  const filePath = path.join(contentsDir, fileName);

  if (!existsSync(filePath)) {
    // Try to copy from defaults first
    const defaultPath = path.join(getDefaultsDir(), fileName);
    if (existsSync(defaultPath)) {
      copyFileSync(defaultPath, filePath);
      console.log(`${symbols.info} Copied default config to ${filePath}`);
    } else {
      console.error(`${symbols.error} Config file not found: ${filePath}`);
      process.exit(1);
    }
  }

  const editor = process.env.EDITOR || process.env.VISUAL || 'nano';
  console.log(`${symbols.info} Opening ${c.cyan(fileName)} in ${editor}...`);

  const { spawn } = await import('child_process');
  await new Promise((resolve, reject) => {
    const editorProcess = spawn(editor, [filePath], {
      stdio: 'inherit',
      shell: false
    });
    editorProcess.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`Editor exited with code ${code}`));
    });
    editorProcess.on('error', reject);
  });

  // Validate JSON after editing
  try {
    JSON.parse(readFileSync(filePath, 'utf-8'));
    console.log(`${symbols.success} Config saved and validated.`);
  } catch (e) {
    console.error(`${symbols.error} Warning: ${fileName} contains invalid JSON: ${e.message}`);
  }
}

async function resetConfig(args) {
  const key = args.filter(a => !a.startsWith('--'))[0];
  const noConfirm = args.includes('--no-confirm');
  const contentsDir = getContentsDir();
  const defaultsDir = getDefaultsDir();

  if (key) {
    const fileName = key.includes('.json') ? key : `config/${key}.json`;
    const defaultPath = path.join(defaultsDir, fileName);

    if (!existsSync(defaultPath)) {
      console.error(`${symbols.error} No default found for: ${fileName}`);
      process.exit(1);
    }

    if (!noConfirm) {
      let clack;
      try {
        clack = await import('@clack/prompts');
      } catch {}
      if (clack) {
        const { confirm, isCancel, cancel } = clack;
        const proceed = await confirm({
          message: `Reset ${fileName} to defaults? This will overwrite your customizations.`,
          initialValue: false
        });
        if (isCancel(proceed) || !proceed) {
          cancel('Reset cancelled.');
          return;
        }
      } else {
        console.error(
          `${symbols.warning} Use --no-confirm to skip confirmation without @clack/prompts`
        );
        process.exit(1);
      }
    }

    const destPath = path.join(contentsDir, fileName);
    copyFileSync(defaultPath, destPath);
    console.log(`${symbols.success} Reset ${fileName} to defaults.`);
  } else {
    // Reset all config
    if (!noConfirm) {
      let clack;
      try {
        clack = await import('@clack/prompts');
      } catch {}
      if (clack) {
        const { confirm, isCancel, cancel } = clack;
        const proceed = await confirm({
          message: `Reset ALL configuration to defaults? This will overwrite all your customizations.`,
          initialValue: false
        });
        if (isCancel(proceed) || !proceed) {
          cancel('Reset cancelled.');
          return;
        }
      } else {
        console.error(
          `${symbols.warning} Use --no-confirm to skip confirmation without @clack/prompts`
        );
        process.exit(1);
      }
    }

    let resetCount = 0;
    for (const file of CONFIG_FILES) {
      const src = path.join(defaultsDir, file);
      const dst = path.join(contentsDir, file);
      if (existsSync(src)) {
        copyFileSync(src, dst);
        resetCount++;
      }
    }
    console.log(`${symbols.success} Reset ${resetCount} config files to defaults.`);
    console.log(`${symbols.warning} Note: App and model configs were not reset.`);
  }
}

export default async function config(args) {
  const [subcommand, ...rest] = args;

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(HELP);
    return;
  }

  switch (subcommand) {
    case 'show':
      await showConfig(rest);
      break;
    case 'edit':
      await editConfig(rest);
      break;
    case 'reset':
      await resetConfig(rest);
      break;
    default:
      console.error(`${symbols.error} Unknown subcommand: ${subcommand}`);
      console.error(`  Run ${c.cyan('ihub config --help')} for usage.`);
      process.exit(1);
  }
}
