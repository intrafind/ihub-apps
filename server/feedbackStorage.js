import fs from 'fs/promises';
import path from 'path';
import { getRootDir } from './pathUtils.js';
import config from './config.js';
import { loadJson } from './configLoader.js';

const contentsDir = config.CONTENTS_DIR;
const dataFile = path.join(getRootDir(), contentsDir, 'data', 'feedback.jsonl');
const SAVE_INTERVAL_MS = 10000;

let trackingEnabled = true;
let configLoaded = false;
let queue = [];
let saveTimer = null;

async function loadConfig() {
  if (configLoaded) return;
  try {
    const cfg = await loadJson('config/platform.json');
    trackingEnabled = cfg?.features?.feedbackTracking !== false;
  } catch {
    trackingEnabled = true;
  }
  configLoaded = true;
}

async function flushQueue() {
  if (queue.length === 0) return;
  await fs.mkdir(path.dirname(dataFile), { recursive: true });
  const lines = queue.map(entry => JSON.stringify(entry)).join('\n') + '\n';
  queue = [];
  await fs.appendFile(dataFile, lines, 'utf8');
}

function scheduleFlush() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await flushQueue();
    } catch (e) {
      console.error('Failed to save feedback data', e);
    }
  }, SAVE_INTERVAL_MS);
}

export function storeFeedback({
  messageId,
  appId,
  chatId,
  modelId,
  rating,
  comment = '',
  contentSnippet = ''
}) {
  // Load config asynchronously if not loaded yet
  if (!configLoaded) {
    loadConfig().catch(e => console.error('Failed to load feedback config:', e));
  }

  if (!trackingEnabled || !messageId) return;
  const entry = {
    timestamp: new Date().toISOString(),
    messageId,
    appId,
    chatId,
    modelId,
    rating,
    comment,
    contentSnippet
  };
  queue.push(entry);
  scheduleFlush();
}

export async function reloadConfig() {
  configLoaded = false;
  await loadConfig();
}

// Start periodic flush interval
setInterval(() => {
  if (queue.length > 0) {
    flushQueue().catch(e => console.error('Feedback save error:', e));
  }
}, SAVE_INTERVAL_MS);
