#!/usr/bin/env node
/**
 * Prepares a local `contents/` directory for screenshot capture:
 * - points every text model at the mock OpenAI-compatible server on :8080
 * - enables the preview feature flags that the website shows
 * - marks first-run setup as completed so the wizard does not appear
 *
 * Run once after the server has generated `contents/` (start it once, then stop it).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CONTENTS = process.env.CONTENTS_DIR || path.join(REPO, 'contents');
const MOCK_URL = process.env.MOCK_URL || 'http://localhost:8080/v1/chat/completions';

const modelsDir = path.join(CONTENTS, 'models');
const textModels = [
  'gpt-5',
  'claude-fable-5-1',
  'claude-haiku-4-5',
  'claude-opus-5',
  'claude-sonnet-5',
  'gemini-3.1-pro',
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash',
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
  'mistral-large',
  'mistral-medium',
  'mistral-small',
  'local-vllm'
];
for (const id of textModels) {
  const file = path.join(modelsDir, `${id}.json`);
  if (!fs.existsSync(file)) continue;
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  Object.assign(m, {
    url: MOCK_URL,
    provider: 'openai',
    enabled: true,
    supportsTools: true,
    autoDiscovery: false,
    apiKey: 'sk-mock-demo-key'
  });
  delete m.thinking;
  m.default = id === 'gemini-flash-latest';
  if (id === 'local-vllm')
    m.name = { en: 'Mistral Small (on-prem vLLM)', de: 'Mistral Small (on-prem vLLM)' };
  fs.writeFileSync(file, JSON.stringify(m, null, 2) + '\n');
}

const featuresFile = path.join(CONTENTS, 'config/features.json');
const features = JSON.parse(fs.readFileSync(featuresFile, 'utf8'));
Object.assign(features, {
  skills: true,
  workflows: true,
  marketplace: true,
  agentFactory: true,
  appAsTool: true,
  runLog: true,
  chatPersistence: true,
  compareMode: true,
  shortLinks: true,
  feedback: true,
  export: true,
  promptsLibrary: true,
  tools: true,
  sources: true,
  integrations: true
});
fs.writeFileSync(featuresFile, JSON.stringify(features, null, 2) + '\n');

const platformFile = path.join(CONTENTS, 'config/platform.json');
const platform = JSON.parse(fs.readFileSync(platformFile, 'utf8'));
platform.setup = { ...(platform.setup || {}), configured: true };
fs.writeFileSync(platformFile, JSON.stringify(platform, null, 2) + '\n');

// Magic prompt in default apps references a model id that is not shipped; point it at the mock default.
const appsDir = path.join(CONTENTS, 'apps');
for (const f of fs.readdirSync(appsDir)) {
  const file = path.join(appsDir, f);
  const txt = fs.readFileSync(file, 'utf8');
  if (txt.includes('"model": "gemini-2.5-flash"'))
    fs.writeFileSync(
      file,
      txt.replaceAll('"model": "gemini-2.5-flash"', '"model": "gemini-flash-latest"')
    );
}
console.log(
  `Prepared ${CONTENTS} for screenshot capture (models → ${MOCK_URL}, preview flags on, setup marked complete).`
);
