/**
 * ihub setup — Interactive first-run setup wizard
 * Usage: ihub setup
 */
import { existsSync, mkdirSync, copyFileSync, readdirSync, writeFileSync, readFileSync } from 'fs';
import path from 'path';
import { c, symbols } from '../utils/colors.js';
import { getContentsDir, getDefaultsDir, getEnvFile } from '../utils/paths.js';

const HELP = `
  ${c.bold('ihub setup')} — Interactive first-run setup wizard

  ${c.bold('Usage:')}
    ihub setup [options]

  ${c.bold('Options:')}
    --force          Re-run setup even if already configured
    -h, --help       Show this help

  ${c.bold('Description:')}
    Guides you through initial configuration:
    • Creates the contents/ directory from defaults
    • Configures API keys for AI providers
    • Sets up the initial admin user (if using local auth)
    • Starts the server when done
`;

function copyDefaults(defaultsDir, contentsDir, subdir) {
  const src = path.join(defaultsDir, subdir);
  const dst = path.join(contentsDir, subdir);
  if (!existsSync(src)) return 0;
  mkdirSync(dst, { recursive: true });
  let count = 0;
  for (const file of readdirSync(src)) {
    const srcFile = path.join(src, file);
    const dstFile = path.join(dst, file);
    if (!existsSync(dstFile)) {
      copyFileSync(srcFile, dstFile);
      count++;
    }
  }
  return count;
}

export default async function setup(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }

  let clack;
  try {
    clack = await import('@clack/prompts');
  } catch {
    console.error(`${symbols.error} @clack/prompts not installed. Run: npm install`);
    process.exit(1);
  }

  const { intro, outro, text, confirm, spinner, isCancel, cancel } = clack;
  const force = args.includes('--force');
  const contentsDir = getContentsDir();
  const defaultsDir = getDefaultsDir();
  const envFile = getEnvFile();

  intro(c.bold(' iHub Apps Setup Wizard '));

  // Check if already set up
  const alreadySetUp = existsSync(path.join(contentsDir, 'config', 'platform.json')) && !force;

  if (alreadySetUp) {
    const proceed = await confirm({
      message: 'iHub appears to already be configured. Re-run setup anyway?',
      initialValue: false
    });

    if (isCancel(proceed) || !proceed) {
      cancel('Setup cancelled. Your existing configuration is unchanged.');
      return;
    }
  }

  // ─── Step 1: Create contents directory ────────────────────────────────
  const s = spinner();
  s.start('Creating configuration directories...');

  const dirs = ['config', 'apps', 'models', 'pages', 'prompts', 'skills', 'sources'];
  let totalCopied = 0;
  for (const dir of dirs) {
    totalCopied += copyDefaults(defaultsDir, contentsDir, dir);
  }

  s.stop(`Configuration directories ready (${totalCopied} files created)`);

  // ─── Step 2: API Keys ─────────────────────────────────────────────────
  const configureKeys = await confirm({
    message: 'Would you like to configure AI provider API keys now?',
    initialValue: true
  });

  if (isCancel(configureKeys)) {
    cancel('Setup cancelled.');
    return;
  }

  const envLines = [];

  if (configureKeys) {
    const providers = [
      { name: 'OpenAI (GPT-4o, etc.)', key: 'OPENAI_API_KEY', hint: 'sk-...' },
      { name: 'Anthropic (Claude)', key: 'ANTHROPIC_API_KEY', hint: 'sk-ant-...' },
      { name: 'Google Gemini', key: 'GOOGLE_API_KEY', hint: 'AIza...' },
      { name: 'Mistral', key: 'MISTRAL_API_KEY', hint: 'your-key' }
    ];

    for (const provider of providers) {
      const existing = process.env[provider.key];
      if (existing) {
        console.log(
          `  ${symbols.success} ${provider.name}: ${c.gray('already set in environment')}`
        );
        continue;
      }

      const value = await text({
        message: `${provider.name} API key (leave blank to skip):`,
        placeholder: provider.hint,
        validate: val => {
          if (val && val.length < 8) return 'API key seems too short';
        }
      });

      if (isCancel(value)) {
        cancel('Setup cancelled.');
        return;
      }

      if (value && value.trim()) {
        envLines.push(`${provider.key}=${value.trim()}`);
      }
    }
  }

  // ─── Step 3: Write .env file ──────────────────────────────────────────
  if (envLines.length > 0) {
    let existingEnv = '';
    if (existsSync(envFile)) {
      existingEnv = readFileSync(envFile, 'utf-8');
    }

    const newLines = envLines.filter(line => {
      const key = line.split('=')[0];
      return !existingEnv.includes(key + '=');
    });

    if (newLines.length > 0) {
      const combined = [existingEnv.trim(), ...newLines].filter(Boolean).join('\n') + '\n';
      writeFileSync(envFile, combined, 'utf-8');
      console.log(`  ${symbols.success} API keys written to ${c.gray(envFile)}`);
    }
  }

  // ─── Step 4: Port configuration ───────────────────────────────────────
  const portChoice = await text({
    message: 'Port to run the server on:',
    placeholder: '3000',
    initialValue: process.env.PORT || '3000',
    validate: val => {
      const n = parseInt(val, 10);
      if (isNaN(n) || n < 1 || n > 65535) return 'Enter a valid port number (1-65535)';
    }
  });

  if (isCancel(portChoice)) {
    cancel('Setup cancelled.');
    return;
  }

  const portNum = parseInt(portChoice || '3000', 10);
  if (portNum !== 3000 && envLines.find(l => l.startsWith('PORT='))) {
    envLines.push(`PORT=${portNum}`);
  } else if (portNum !== 3000) {
    let existingEnv = existsSync(envFile) ? readFileSync(envFile, 'utf-8') : '';
    if (!existingEnv.includes('PORT=')) {
      writeFileSync(envFile, existingEnv.trimEnd() + `\nPORT=${portNum}\n`, 'utf-8');
    }
  }

  // ─── Step 5: Start the server ─────────────────────────────────────────
  const startNow = await confirm({
    message: 'Start the server now?',
    initialValue: true
  });

  if (isCancel(startNow)) {
    cancel('Setup cancelled.');
    return;
  }

  outro(
    startNow
      ? `${c.green('Setup complete!')} Starting server...`
      : `${c.green('Setup complete!')} Run ${c.cyan('ihub start')} when ready.`
  );

  if (startNow) {
    const { default: start } = await import('./start.js');
    await start([`--port`, String(portNum)]);
  }
}
