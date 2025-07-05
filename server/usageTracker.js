import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getRootDir } from './pathUtils.js';
import config from './config.js';
import { loadJson } from './configLoader.js';
import { recordTokenUsage } from './telemetry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const contentsDir = config.CONTENTS_DIR;
const dataFile = path.join(getRootDir(), contentsDir, 'data', 'usage.json');
const SAVE_INTERVAL_MS = 10000;
const now = () => new Date().toISOString();

let usage = null;
let trackingEnabled = true;
let dirty = false;
let saveTimer = null;

function createDefaultUsage() {
  return {
    messages: { total: 0, perUser: {}, perApp: {}, perModel: {} },
    tokens: {
      total: 0,
      perUser: {},
      perApp: {},
      perModel: {},
      prompt: { total: 0, perUser: {}, perApp: {}, perModel: {} },
      completion: { total: 0, perUser: {}, perApp: {}, perModel: {} }
    },
    feedback: { good: 0, bad: 0, perUser: {}, perApp: {}, perModel: {} },
    magicPrompt: {
      total: 0,
      tokensIn: { total: 0, perUser: {}, perApp: {}, perModel: {} },
      tokensOut: { total: 0, perUser: {}, perApp: {}, perModel: {} },
      perUser: {},
      perApp: {},
      perModel: {}
    },
    lastUpdated: now(),
    lastReset: now()
  };
}

async function loadConfig() {
  try {
    const cfg = await loadJson('config/platform.json');
    trackingEnabled = cfg?.features?.usageTracking !== false;
  } catch {
    trackingEnabled = true;
  }
}

async function loadUsage() {
  if (usage) return usage;
  try {
    const data = await fs.readFile(dataFile, 'utf8');
    usage = JSON.parse(data);
    usage.lastUpdated = usage.lastUpdated || now();
    usage.lastReset = usage.lastReset || now();
  } catch {
    usage = createDefaultUsage();
  }
  return usage;
}

async function saveUsage() {
  if (!usage || !dirty) return;
  await fs.mkdir(path.dirname(dataFile), { recursive: true });
  usage.lastUpdated = now();
  await fs.writeFile(dataFile, JSON.stringify(usage, null, 2));
  dirty = false;
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await saveUsage();
    } catch (e) {
      console.error('Failed to save usage data', e);
    }
  }, SAVE_INTERVAL_MS);
}

function inc(map, key, amount) {
  if (!key) return;
  map[key] = (map[key] || 0) + amount;
}

function incFeedback(map, key, rating) {
  if (!key) return;
  map[key] = map[key] || { good: 0, bad: 0 };
  map[key][rating] = (map[key][rating] || 0) + 1;
}

export function estimateTokens(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).length;
}

export async function recordChatRequest({ userId, appId, modelId, tokens = 0 }) {
  if (!trackingEnabled) return;
  const data = await loadUsage();
  data.messages.total += 1;
  inc(data.messages.perUser, userId, 1);
  inc(data.messages.perApp, appId, 1);
  inc(data.messages.perModel, modelId, 1);

  data.tokens.total += tokens;
  inc(data.tokens.perUser, userId, tokens);
  inc(data.tokens.perApp, appId, tokens);
  inc(data.tokens.perModel, modelId, tokens);
  inc(data.tokens.prompt.perUser, userId, tokens);
  inc(data.tokens.prompt.perApp, appId, tokens);
  inc(data.tokens.prompt.perModel, modelId, tokens);
  inc(data.tokens.prompt, 'total', tokens);
  recordTokenUsage(tokens);
  dirty = true;
  scheduleSave();
}

export async function recordChatResponse({ userId, appId, modelId, tokens = 0 }) {
  if (!trackingEnabled) return;
  const data = await loadUsage();
  data.messages.total += 1;
  inc(data.messages.perUser, userId, 1);
  inc(data.messages.perApp, appId, 1);
  inc(data.messages.perModel, modelId, 1);

  data.tokens.total += tokens;
  inc(data.tokens.perUser, userId, tokens);
  inc(data.tokens.perApp, appId, tokens);
  inc(data.tokens.perModel, modelId, tokens);
  inc(data.tokens.completion.perUser, userId, tokens);
  inc(data.tokens.completion.perApp, appId, tokens);
  inc(data.tokens.completion.perModel, modelId, tokens);
  inc(data.tokens.completion, 'total', tokens);
  recordTokenUsage(tokens);
  dirty = true;
  scheduleSave();
}

export async function recordFeedback({ userId, appId, modelId, rating }) {
  if (!trackingEnabled) return;
  const data = await loadUsage();
  const r = rating === 'positive' ? 'good' : 'bad';
  data.feedback[r] += 1;
  incFeedback(data.feedback.perUser, userId, r);
  incFeedback(data.feedback.perApp, appId, r);
  incFeedback(data.feedback.perModel, modelId, r);
  dirty = true;
  scheduleSave();
}

export async function recordMagicPrompt({ userId, appId, modelId, inputTokens = 0, outputTokens = 0 }) {
  if (!trackingEnabled) return;
  const data = await loadUsage();
  data.magicPrompt.total += 1;
  inc(data.magicPrompt.perUser, userId, 1);
  inc(data.magicPrompt.perApp, appId, 1);
  inc(data.magicPrompt.perModel, modelId, 1);

  inc(data.magicPrompt.tokensIn.perUser, userId, inputTokens);
  inc(data.magicPrompt.tokensIn.perApp, appId, inputTokens);
  inc(data.magicPrompt.tokensIn.perModel, modelId, inputTokens);
  inc(data.magicPrompt.tokensIn, 'total', inputTokens);

  inc(data.magicPrompt.tokensOut.perUser, userId, outputTokens);
  inc(data.magicPrompt.tokensOut.perApp, appId, outputTokens);
  inc(data.magicPrompt.tokensOut.perModel, modelId, outputTokens);
  inc(data.magicPrompt.tokensOut, 'total', outputTokens);

  recordTokenUsage(inputTokens + outputTokens);

  dirty = true;
  scheduleSave();
}

export async function getUsage() {
  return loadUsage();
}

export function isTrackingEnabled() {
  return trackingEnabled;
}

export async function resetUsage() {
  usage = createDefaultUsage();
  usage.lastReset = now();
  dirty = true;
  await saveUsage();
}

// Initialize configuration and load existing usage data
loadConfig();
loadUsage();
setInterval(() => {
  if (dirty) saveUsage().catch(e => console.error('Usage save error:', e));
}, SAVE_INTERVAL_MS);

export async function reloadConfig() {
  await loadConfig();
}
