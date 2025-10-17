import fs from 'fs/promises';
import path from 'path';
import { getRootDir } from './pathUtils.js';
import config from './config.js';
import { loadJson } from './configLoader.js';
import { recordTokenUsage } from './telemetry.js';

const contentsDir = config.CONTENTS_DIR;
const dataFile = path.join(getRootDir(), contentsDir, 'data', 'usage.json');
const SAVE_INTERVAL_MS = 10000;
const now = () => new Date().toISOString();

let usage = null;
let trackingEnabled = true;
let configLoaded = false;
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
    feedback: {
      total: 0,
      ratings: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      averageRating: 0,
      perUser: {},
      perApp: {},
      perModel: {},
      // Legacy format for backward compatibility
      good: 0,
      bad: 0
    },
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
  if (configLoaded) return;
  try {
    const cfg = await loadJson('config/platform.json');
    trackingEnabled = cfg?.features?.usageTracking !== false;
  } catch {
    trackingEnabled = true;
  }
  configLoaded = true;
}

function migrateLegacyFeedback(feedbackObj) {
  if (!feedbackObj || typeof feedbackObj !== 'object') return;

  // Initialize structure if missing
  if (!feedbackObj.ratings) {
    feedbackObj.ratings = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    feedbackObj.total = feedbackObj.total || 0;
    feedbackObj.averageRating = feedbackObj.averageRating || 0;
  }

  const good = feedbackObj.good || 0;
  const bad = feedbackObj.bad || 0;
  const legacyTotal = good + bad;

  // Only migrate if we have legacy data that hasn't been migrated yet
  // Check if total is 0 but we have good/bad counts, OR if ratings are all 0 but we have good/bad
  const hasLegacyData = good > 0 || bad > 0;
  const hasEmptyRatings =
    feedbackObj.ratings[1] === 0 &&
    feedbackObj.ratings[2] === 0 &&
    feedbackObj.ratings[3] === 0 &&
    feedbackObj.ratings[4] === 0 &&
    feedbackObj.ratings[5] === 0;
  const needsMigration = hasLegacyData && (feedbackObj.total === 0 || hasEmptyRatings);

  if (needsMigration) {
    // Map legacy "good" to rating 5 and "bad" to rating 1
    feedbackObj.ratings[5] += good;
    feedbackObj.ratings[1] += bad;
    feedbackObj.total = legacyTotal;

    // Calculate weighted average: (5*good + 1*bad) / total
    if (feedbackObj.total > 0) {
      const weightedSum = 5 * good + 1 * bad;
      feedbackObj.averageRating = weightedSum / feedbackObj.total;
    } else {
      feedbackObj.averageRating = 0;
    }
  }

  // Keep legacy fields for backward compatibility
  feedbackObj.good = feedbackObj.good || 0;
  feedbackObj.bad = feedbackObj.bad || 0;
}

async function loadUsage() {
  if (usage) return usage;
  try {
    const data = await fs.readFile(dataFile, 'utf8');
    usage = JSON.parse(data);
    usage.lastUpdated = usage.lastUpdated || now();
    usage.lastReset = usage.lastReset || now();

    // Migrate top-level feedback
    if (usage.feedback) {
      migrateLegacyFeedback(usage.feedback);

      // Migrate all nested feedback objects (perUser, perApp, perModel)
      ['perUser', 'perApp', 'perModel'].forEach(key => {
        if (usage.feedback[key]) {
          Object.keys(usage.feedback[key]).forEach(id => {
            const feedbackItem = usage.feedback[key][id];
            migrateLegacyFeedback(feedbackItem);
          });
        }
      });

      // Mark as migrated by saving immediately
      dirty = true;
      await saveUsage();
    }
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
  map[key] = map[key] || {
    total: 0,
    ratings: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    averageRating: 0,
    // Legacy format for backward compatibility
    good: 0,
    bad: 0
  };

  // Handle numeric ratings (1-5)
  if (typeof rating === 'number') {
    const roundedRating = Math.round(rating * 2) / 2; // Round to nearest 0.5
    const ratingKey = Math.ceil(roundedRating); // Round up for indexing (1.5 -> 2)

    if (ratingKey >= 1 && ratingKey <= 5) {
      map[key].ratings[ratingKey] += 1;
      map[key].total += 1;

      // Calculate new average rating
      const totalRatings = Object.values(map[key].ratings).reduce((sum, count) => sum + count, 0);
      const weightedSum = Object.entries(map[key].ratings).reduce(
        (sum, [rating, count]) => sum + parseInt(rating) * count,
        0
      );
      map[key].averageRating = totalRatings > 0 ? weightedSum / totalRatings : 0;

      // Update legacy format (ratings 4-5 = good, ratings 1-3 = bad)
      if (ratingKey >= 4) {
        map[key].good += 1;
      } else {
        map[key].bad += 1;
      }
    }
  } else {
    // Handle legacy string format for backward compatibility
    const legacyRating = rating === 'positive' ? 'good' : 'bad';
    map[key][legacyRating] = (map[key][legacyRating] || 0) + 1;
  }
}

export function estimateTokens(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).length;
}

export async function recordChatRequest({ userId, appId, modelId, tokens = 0 }) {
  await loadConfig();
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
  await loadConfig();
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
  await loadConfig();
  if (!trackingEnabled) return;
  const data = await loadUsage();

  // Handle numeric ratings (1-5)
  if (typeof rating === 'number') {
    const roundedRating = Math.round(rating * 2) / 2; // Round to nearest 0.5
    const ratingKey = Math.ceil(roundedRating); // Round up for indexing

    if (ratingKey >= 1 && ratingKey <= 5) {
      data.feedback.ratings[ratingKey] += 1;
      data.feedback.total += 1;

      // Calculate new average rating
      const totalRatings = Object.values(data.feedback.ratings).reduce(
        (sum, count) => sum + count,
        0
      );
      const weightedSum = Object.entries(data.feedback.ratings).reduce(
        (sum, [rating, count]) => sum + parseInt(rating) * count,
        0
      );
      data.feedback.averageRating = totalRatings > 0 ? weightedSum / totalRatings : 0;

      // Update legacy format (ratings 4-5 = good, ratings 1-3 = bad)
      if (ratingKey >= 4) {
        data.feedback.good += 1;
      } else {
        data.feedback.bad += 1;
      }
    }
  } else {
    // Handle legacy string format for backward compatibility
    const r = rating === 'positive' ? 'good' : 'bad';
    data.feedback[r] += 1;
  }

  incFeedback(data.feedback.perUser, userId, rating);
  incFeedback(data.feedback.perApp, appId, rating);
  incFeedback(data.feedback.perModel, modelId, rating);
  dirty = true;
  scheduleSave();
}

export async function recordMagicPrompt({
  userId,
  appId,
  modelId,
  inputTokens = 0,
  outputTokens = 0
}) {
  await loadConfig();
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
  await loadConfig();
  return loadUsage();
}

export async function isTrackingEnabled() {
  await loadConfig();
  return trackingEnabled;
}

export async function resetUsage() {
  await loadConfig();
  usage = createDefaultUsage();
  usage.lastReset = now();
  dirty = true;
  await saveUsage();
}

export async function reloadConfig() {
  configLoaded = false;
  await loadConfig();
}

// Start periodic save interval
setInterval(() => {
  if (dirty) saveUsage().catch(e => console.error('Usage save error:', e));
}, SAVE_INTERVAL_MS);
