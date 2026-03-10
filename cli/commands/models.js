/**
 * ihub models — Manage LLM models
 * Usage: ihub models <subcommand> [options]
 * Subcommands: list, add, test
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { c, symbols } from '../utils/colors.js';
import { getContentsDir, getDefaultsDir } from '../utils/paths.js';
import { parseServerArgs, checkHealth } from '../utils/api.js';

const HELP = `
  ${c.bold('ihub models')} — Manage LLM models

  ${c.bold('Usage:')}
    ihub models <subcommand> [options]

  ${c.bold('Subcommands:')}
    list              Show all configured models
    add               Interactive model addition wizard
    test [id]         Test model connectivity (all or specific model)

  ${c.bold('Options:')}
    --json            Output list as JSON (for 'list')
    --port <port>     Server port for 'test' (default: 3000)
    -h, --help        Show this help

  ${c.bold('Examples:')}
    ihub models list
    ihub models test
    ihub models test gpt-4o
`;

const PROVIDERS = {
  openai: { name: 'OpenAI', keyVar: 'OPENAI_API_KEY' },
  anthropic: { name: 'Anthropic', keyVar: 'ANTHROPIC_API_KEY' },
  google: { name: 'Google', keyVar: 'GOOGLE_API_KEY' },
  mistral: { name: 'Mistral', keyVar: 'MISTRAL_API_KEY' },
  'azure-openai': { name: 'Azure OpenAI', keyVar: 'AZURE_OPENAI_API_KEY' },
  vllm: { name: 'vLLM (local)', keyVar: null },
  iassistant: { name: 'iAssistant', keyVar: null }
};

function loadModels() {
  const contentsDir = getContentsDir();
  const defaultsDir = getDefaultsDir();

  const modelsDir = existsSync(path.join(contentsDir, 'models'))
    ? path.join(contentsDir, 'models')
    : path.join(defaultsDir, 'models');

  if (!existsSync(modelsDir)) return [];

  const models = [];
  for (const file of readdirSync(modelsDir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const data = JSON.parse(readFileSync(path.join(modelsDir, file), 'utf-8'));
      models.push({ ...data, _file: path.join(modelsDir, file) });
    } catch {}
  }

  return models.sort((a, b) => {
    const pa = a.provider || '';
    const pb = b.provider || '';
    return pa.localeCompare(pb) || (a.id || '').localeCompare(b.id || '');
  });
}

function getModelName(model) {
  if (typeof model.name === 'string') return model.name;
  return model.name?.en || model.name?.de || model.id || 'unknown';
}

function hasApiKey(model) {
  const provider = PROVIDERS[model.provider];
  if (!provider?.keyVar) return true; // local providers don't need keys
  if (model.apiKey && !model.apiKey.startsWith('ENC[')) return true; // per-model key
  return !!process.env[provider.keyVar];
}

async function listModels(args) {
  const asJson = args.includes('--json');
  const models = loadModels();

  if (models.length === 0) {
    console.log(`${symbols.info} No models configured.`);
    console.log(`  Run ${c.cyan('ihub models add')} to add one.`);
    return;
  }

  if (asJson) {
    console.log(
      JSON.stringify(
        models.map(m => ({
          id: m.id,
          name: getModelName(m),
          provider: m.provider,
          enabled: m.enabled !== false,
          hasApiKey: hasApiKey(m)
        })),
        null,
        2
      )
    );
    return;
  }

  console.log('');
  console.log(`  ${c.bold(`Models (${models.length} total)`)}`);
  console.log(`  ${c.gray('─'.repeat(70))}`);

  // Group by provider
  const byProvider = {};
  for (const model of models) {
    const p = model.provider || 'unknown';
    if (!byProvider[p]) byProvider[p] = [];
    byProvider[p].push(model);
  }

  for (const [provider, providerModels] of Object.entries(byProvider)) {
    const pInfo = PROVIDERS[provider];
    const pName = pInfo?.name || provider;
    const keyOk = pInfo?.keyVar ? !!process.env[pInfo.keyVar] : true;
    const keyStatus = keyOk ? c.green('key ✓') : c.red('key missing');

    console.log('');
    console.log(`  ${c.cyan(pName)} ${c.gray(`(${keyStatus})`)}`);

    for (const model of providerModels) {
      const enabled = model.enabled !== false;
      const icon = enabled ? symbols.success : c.gray('○');
      const name = enabled ? c.white(getModelName(model)) : c.gray(getModelName(model));
      const id = c.gray(model.id || '—');
      const modelId = model.modelId ? c.gray(` → ${model.modelId}`) : '';
      const tools = model.supportsTools ? c.gray(' [tools]') : '';
      console.log(`    ${icon} ${name}${tools}`);
      console.log(`       ${c.gray('id:')} ${id}${modelId}`);
    }
  }

  const withKey = models.filter(m => hasApiKey(m) && m.enabled !== false).length;
  const total = models.filter(m => m.enabled !== false).length;

  console.log('');
  console.log(`  ${c.gray(`${withKey}/${total} enabled models have API keys configured.`)}`);
  console.log('');
}

async function testModel(args) {
  const { port, host } = parseServerArgs(args);
  const targetId = args.filter(a => !a.startsWith('-') && !a.match(/^\d+$/))[0];

  // Check if server is running
  const health = await checkHealth(port, host);
  if (!health) {
    console.error(`${symbols.error} Server is not running on port ${port}.`);
    console.error(`  Start it first: ${c.cyan('ihub start')}`);
    process.exit(1);
  }

  const models = loadModels().filter(m => m.enabled !== false);
  const toTest = targetId ? models.filter(m => m.id === targetId) : models;

  if (toTest.length === 0) {
    if (targetId) {
      console.error(`${symbols.error} Model not found: ${targetId}`);
    } else {
      console.log(`${symbols.info} No enabled models to test.`);
    }
    return;
  }

  console.log('');
  console.log(`  ${c.bold(`Testing ${toTest.length} model${toTest.length > 1 ? 's' : ''}...`)}`);
  console.log(`  ${c.gray('─'.repeat(50))}`);

  const baseUrl = `http://${host}:${port}`;
  let passed = 0;
  let failed = 0;

  for (const model of toTest) {
    const name = getModelName(model);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);

      const res = await fetch(`${baseUrl}/api/models`, { signal: controller.signal });
      clearTimeout(timer);

      if (res.ok) {
        const data = await res.json();
        const found = (data.models || data).some?.(m => m.id === model.id);
        if (found) {
          console.log(`  ${symbols.success} ${c.white(name)} ${c.gray(`(${model.id})`)}`);
          passed++;
        } else {
          console.log(`  ${symbols.warning} ${name} ${c.gray('— registered but not listed')}`);
          passed++;
        }
      } else {
        console.log(`  ${symbols.error} ${name} ${c.gray(`— HTTP ${res.status}`)}`);
        failed++;
      }
    } catch (err) {
      console.log(`  ${symbols.error} ${name} ${c.gray(`— ${err.message}`)}`);
      failed++;
    }
  }

  console.log('');
  console.log(
    `  ${symbols.info} ${c.green(`${passed} passed`)}${failed > 0 ? `, ${c.red(`${failed} failed`)}` : ''}`
  );
  console.log('');

  if (failed > 0) process.exit(1);
}

async function addModel(args) {
  let clack;
  try {
    clack = await import('@clack/prompts');
  } catch {
    console.error(`${symbols.error} @clack/prompts not installed. Run: npm install`);
    process.exit(1);
  }

  const { intro, outro, text, select, isCancel, cancel } = clack;

  intro(c.bold(' Add a new Model '));

  const provider = await select({
    message: 'Provider:',
    options: [
      { value: 'openai', label: 'OpenAI (GPT-4o, o3, etc.)' },
      { value: 'anthropic', label: 'Anthropic (Claude)' },
      { value: 'google', label: 'Google (Gemini)' },
      { value: 'mistral', label: 'Mistral' },
      { value: 'azure-openai', label: 'Azure OpenAI' },
      { value: 'openai', label: 'Local (LM Studio, vLLM, etc.) — uses OpenAI-compatible API' }
    ]
  });
  if (isCancel(provider)) {
    cancel('Cancelled.');
    return;
  }

  const id = await text({
    message: 'Model config ID (unique):',
    placeholder: 'gpt-4o',
    validate: val => {
      if (!val) return 'ID is required';
    }
  });
  if (isCancel(id)) {
    cancel('Cancelled.');
    return;
  }

  const modelId = await text({
    message: 'API model identifier:',
    placeholder: 'gpt-4o',
    initialValue: id
  });
  if (isCancel(modelId)) {
    cancel('Cancelled.');
    return;
  }

  const nameEn = await text({
    message: 'Display name:',
    placeholder: 'GPT-4o',
    initialValue: id
  });
  if (isCancel(nameEn)) {
    cancel('Cancelled.');
    return;
  }

  const tokenLimit = await text({
    message: 'Token limit:',
    initialValue: '128000',
    validate: val => {
      if (isNaN(parseInt(val))) return 'Enter a number';
    }
  });
  if (isCancel(tokenLimit)) {
    cancel('Cancelled.');
    return;
  }

  const modelConfig = {
    id: id.trim(),
    modelId: modelId.trim(),
    name: { en: nameEn.trim() },
    provider: provider,
    tokenLimit: parseInt(tokenLimit, 10),
    enabled: true,
    supportsTools: false
  };

  const contentsDir = getContentsDir();
  const modelsDir = path.join(contentsDir, 'models');

  if (!existsSync(modelsDir)) {
    console.error(
      `${symbols.error} Models directory not found. Run ${c.cyan('ihub start')} first.`
    );
    cancel('');
    return;
  }

  const outFile = path.join(modelsDir, `${id}.json`);
  if (existsSync(outFile)) {
    const { confirm } = clack;
    const overwrite = await confirm({ message: `Model '${id}' already exists. Overwrite?` });
    if (isCancel(overwrite) || !overwrite) {
      cancel('Cancelled.');
      return;
    }
  }

  writeFileSync(outFile, JSON.stringify(modelConfig, null, 2) + '\n', 'utf-8');
  outro(`${c.green('Model added!')} ${c.gray(outFile)}`);
}

export default async function models(args) {
  const [subcommand, ...rest] = args;

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(HELP);
    return;
  }

  switch (subcommand) {
    case 'list':
      await listModels(rest);
      break;
    case 'add':
      await addModel(rest);
      break;
    case 'test':
      await testModel(rest);
      break;
    default:
      console.error(`${symbols.error} Unknown subcommand: ${subcommand}`);
      console.error(`  Run ${c.cyan('ihub models --help')} for usage.`);
      process.exit(1);
  }
}
