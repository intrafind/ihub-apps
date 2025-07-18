import fs from 'fs/promises';
import path from 'path';
import { getRootDir } from './pathUtils.js';
import config from './config.js';
import { loadJson } from './configLoader.js';

const contentsDir = config.CONTENTS_DIR;
const dataFile = path.join(getRootDir(), contentsDir, 'data', 'feedback.jsonl');
const SAVE_INTERVAL_MS = 10000;

let trackingEnabled = true;
let queue = [];
let saveTimer = null;

async function loadConfig() {
  try {
    const cfg = await loadJson('config/platform.json');
    trackingEnabled = cfg?.features?.feedbackTracking !== false;
  } catch {
    trackingEnabled = true;
  }
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

export function storeFeedback({ messageId, appId, chatId, modelId, rating, comment = '', contentSnippet = '' }) {
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

loadConfig();
setInterval(() => {
  if (queue.length > 0) {
    flushQueue().catch(e => console.error('Feedback save error:', e));
  }
}, SAVE_INTERVAL_MS);

export async function reloadConfig() {
  await loadConfig();
}
