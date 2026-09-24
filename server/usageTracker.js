import path from 'path';
import { getRootDir } from './pathUtils.js';
import config from './config.js';

import { recordTokenUsage } from './telemetry.js';
import { recordMagicPromptUsage, recordFeedbackEvent } from './telemetry/metrics.js';
import { resolveUserId } from './services/UserFingerprint.js';
import { logUsageEvent } from './services/UsageEventLog.js';
import { createDebouncedJsonStore } from './utils/debouncedJsonStore.js';
import { estimateTokens as estimateTokensShared } from '../shared/tokenEstimator.js';

const contentsDir = config.CONTENTS_DIR;
const dataFile = path.join(getRootDir(), contentsDir, 'data', 'usage.json');
const now = () => new Date().toISOString();

let trackingEnabled = true;
let trackingMode = 'pseudonymous';
let configLoaded = false;
let migrationChecked = false;

/**
 * Prompt-cache and reasoning counters, kept under `tokens`. Subsets of the
 * prompt (cache) and completion (reasoning) totals, recorded only when the
 * provider reports them. `perProvider` lets admins compare adapters.
 */
const DETAIL_BUCKETS = ['cacheRead', 'cacheWrite', 'reasoning'];

function createCounterBucket() {
  return { total: 0, perUser: {}, perApp: {}, perModel: {}, perProvider: {} };
}

function createDefaultUsage() {
  return {
    messages: { total: 0, perUser: {}, perApp: {}, perModel: {} },
    tokens: {
      total: 0,
      perUser: {},
      perApp: {},
      perModel: {},
      prompt: { total: 0, perUser: {}, perApp: {}, perModel: {}, perProvider: {} },
      completion: { total: 0, perUser: {}, perApp: {}, perModel: {}, perProvider: {} },
      cacheRead: createCounterBucket(),
      cacheWrite: createCounterBucket(),
      reasoning: createCounterBucket()
    },
    // Provider-run web searches billed on top of tokens (Anthropic web search).
    webSearch: { total: 0, perUser: {}, perApp: {}, perModel: {} },
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
    tokenSources: { provider: 0, estimate: 0 },
    lastUpdated: now(),
    lastReset: now()
  };
}

const store = createDebouncedJsonStore({
  filePath: dataFile,
  createDefault: createDefaultUsage,
  component: 'UsageTracker',
  onBeforeSave: data => {
    data.lastUpdated = now();
  }
});

async function loadConfig() {
  if (configLoaded) return;
  try {
    const { isFeatureEnabled } = await import('./featureRegistry.js');
    const configCache = (await import('./configCache.js')).default;
    const features = configCache.getFeatures();
    trackingEnabled = isFeatureEnabled('usageTracking', features);
    const platformConfig = configCache.getPlatform();
    trackingMode = platformConfig?.features?.usageTrackingMode || 'pseudonymous';
  } catch {
    trackingEnabled = true;
  }
  configLoaded = true;
}

export function reloadConfig() {
  configLoaded = false;
}

function migrateLegacyFeedback(feedbackObj) {
  if (!feedbackObj || typeof feedbackObj !== 'object') return false;

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
    feedbackObj.averageRating = computeAverageRating(feedbackObj.ratings);
  }

  // Keep legacy fields for backward compatibility
  feedbackObj.good = feedbackObj.good || 0;
  feedbackObj.bad = feedbackObj.bad || 0;

  return needsMigration;
}

async function loadUsage() {
  const data = await store.load();
  if (!migrationChecked) {
    migrationChecked = true;
    data.lastUpdated = data.lastUpdated || now();
    data.lastReset = data.lastReset || now();

    if (data.feedback) {
      let changed = migrateLegacyFeedback(data.feedback);

      // Migrate all nested feedback objects (perUser, perApp, perModel)
      ['perUser', 'perApp', 'perModel'].forEach(key => {
        if (data.feedback[key]) {
          Object.keys(data.feedback[key]).forEach(id => {
            if (migrateLegacyFeedback(data.feedback[key][id])) changed = true;
          });
        }
      });

      // Mark as migrated by saving immediately
      if (changed) {
        store.markDirty();
        await store.flush();
      }
    }
  }
  return data;
}

function inc(map, key, amount) {
  if (!key) return;
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') return;
  map[key] = (map[key] || 0) + amount;
}

function computeAverageRating(ratings) {
  const totalRatings = Object.values(ratings).reduce((sum, count) => sum + count, 0);
  if (totalRatings === 0) return 0;
  const weightedSum = Object.entries(ratings).reduce(
    (sum, [rating, count]) => sum + parseInt(rating) * count,
    0
  );
  return weightedSum / totalRatings;
}

function applyRating(bucket, rating) {
  // Handle numeric ratings (1-5)
  if (typeof rating === 'number') {
    const roundedRating = Math.round(rating * 2) / 2; // Round to nearest 0.5
    const ratingKey = Math.ceil(roundedRating); // Round up for indexing (1.5 -> 2)

    if (ratingKey >= 1 && ratingKey <= 5) {
      bucket.ratings[ratingKey] += 1;
      bucket.total += 1;
      bucket.averageRating = computeAverageRating(bucket.ratings);

      // Update legacy format (ratings 4-5 = good, ratings 1-3 = bad)
      if (ratingKey >= 4) {
        bucket.good += 1;
      } else {
        bucket.bad += 1;
      }
    }
  } else {
    // Handle legacy string format for backward compatibility
    const legacyRating = rating === 'positive' ? 'good' : 'bad';
    bucket[legacyRating] = (bucket[legacyRating] || 0) + 1;
  }
}

function incFeedback(map, key, rating) {
  if (!key) return;
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') return;
  map[key] = map[key] || {
    total: 0,
    ratings: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    averageRating: 0,
    // Legacy format for backward compatibility
    good: 0,
    bad: 0
  };
  applyRating(map[key], rating);
}

export function estimateTokens(text) {
  return estimateTokensShared(text);
}

/** A provider-reported count, or undefined when it was not reported. */
function reportedCount(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

function addToBucket(bucket, { resolvedUser, appId, modelId, provider }, amount) {
  inc(bucket, 'total', amount);
  inc(bucket.perUser, resolvedUser, amount);
  inc(bucket.perApp, appId, amount);
  inc(bucket.perModel, modelId, amount);
  if (provider) {
    if (!bucket.perProvider) bucket.perProvider = {};
    inc(bucket.perProvider, provider, amount);
  }
}

async function recordChatMessage({
  direction,
  userId,
  appId,
  modelId,
  provider,
  tokens = 0,
  tokenSource = 'estimate',
  cacheReadTokens,
  cacheWriteTokens,
  reasoningTokens,
  webSearchRequests = 0,
  user
}) {
  await loadConfig();
  if (!trackingEnabled) return;
  const resolvedUser =
    trackingMode === 'identified' && user?.id ? user.id : await resolveUserId(userId, trackingMode);
  const data = await loadUsage();
  data.messages.total += 1;
  inc(data.messages.perUser, resolvedUser, 1);
  inc(data.messages.perApp, appId, 1);
  inc(data.messages.perModel, modelId, 1);

  data.tokens.total += tokens;
  inc(data.tokens.perUser, resolvedUser, tokens);
  inc(data.tokens.perApp, appId, tokens);
  inc(data.tokens.perModel, modelId, tokens);
  const dims = { resolvedUser, appId, modelId, provider };
  addToBucket(data.tokens[direction], dims, tokens);
  const details = {
    cacheRead: reportedCount(cacheReadTokens),
    cacheWrite: reportedCount(cacheWriteTokens),
    reasoning: reportedCount(reasoningTokens)
  };
  for (const key of DETAIL_BUCKETS) {
    if (details[key] === undefined) continue;
    if (!data.tokens[key]) data.tokens[key] = createCounterBucket();
    addToBucket(data.tokens[key], dims, details[key]);
  }
  if (!data.tokenSources) data.tokenSources = { provider: 0, estimate: 0 };
  data.tokenSources[tokenSource] = (data.tokenSources[tokenSource] || 0) + 1;
  if (webSearchRequests > 0) {
    if (!data.webSearch) data.webSearch = { total: 0, perUser: {}, perApp: {}, perModel: {} };
    data.webSearch.total += webSearchRequests;
    inc(data.webSearch.perUser, resolvedUser, webSearchRequests);
    inc(data.webSearch.perApp, appId, webSearchRequests);
    inc(data.webSearch.perModel, modelId, webSearchRequests);
  }
  recordTokenUsage(tokens);
  logUsageEvent({
    type: direction === 'prompt' ? 'chat_request' : 'chat_response',
    userId: resolvedUser,
    appId,
    modelId,
    provider,
    ...(direction === 'prompt' ? { promptTokens: tokens } : { completionTokens: tokens }),
    cacheReadTokens: details.cacheRead,
    cacheWriteTokens: details.cacheWrite,
    reasoningTokens: details.reasoning,
    ...(webSearchRequests > 0 ? { webSearchRequests } : {}),
    tokenSource
  });
  store.markDirty();
}

export async function recordChatRequest(args) {
  return recordChatMessage({ ...args, direction: 'prompt' });
}

export async function recordChatResponse(args) {
  return recordChatMessage({ ...args, direction: 'completion' });
}

export async function recordFeedback({ userId, appId, modelId, rating, user }) {
  await loadConfig();
  if (!trackingEnabled) return;
  const resolvedUser =
    trackingMode === 'identified' && user?.id ? user.id : await resolveUserId(userId, trackingMode);
  const data = await loadUsage();

  applyRating(data.feedback, rating);

  incFeedback(data.feedback.perUser, resolvedUser, rating);
  incFeedback(data.feedback.perApp, appId, rating);
  incFeedback(data.feedback.perModel, modelId, rating);
  recordFeedbackEvent(appId, rating);
  logUsageEvent({
    type: 'feedback',
    userId: resolvedUser,
    appId,
    modelId,
    rating
  });
  store.markDirty();
}

export async function recordMagicPrompt({
  userId,
  appId,
  modelId,
  inputTokens = 0,
  outputTokens = 0,
  user
}) {
  await loadConfig();
  if (!trackingEnabled) return;
  const resolvedUser =
    trackingMode === 'identified' && user?.id ? user.id : await resolveUserId(userId, trackingMode);
  const data = await loadUsage();
  data.magicPrompt.total += 1;
  inc(data.magicPrompt.perUser, resolvedUser, 1);
  inc(data.magicPrompt.perApp, appId, 1);
  inc(data.magicPrompt.perModel, modelId, 1);

  inc(data.magicPrompt.tokensIn.perUser, resolvedUser, inputTokens);
  inc(data.magicPrompt.tokensIn.perApp, appId, inputTokens);
  inc(data.magicPrompt.tokensIn.perModel, modelId, inputTokens);
  inc(data.magicPrompt.tokensIn, 'total', inputTokens);

  inc(data.magicPrompt.tokensOut.perUser, resolvedUser, outputTokens);
  inc(data.magicPrompt.tokensOut.perApp, appId, outputTokens);
  inc(data.magicPrompt.tokensOut.perModel, modelId, outputTokens);
  inc(data.magicPrompt.tokensOut, 'total', outputTokens);

  recordTokenUsage(inputTokens + outputTokens);
  recordMagicPromptUsage(appId);
  logUsageEvent({
    type: 'magic_prompt',
    userId: resolvedUser,
    appId,
    modelId,
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    tokenSource: 'estimate'
  });

  store.markDirty();
}

export async function getUsage() {
  await loadConfig();
  // Force a fresh read rather than serving whatever this worker's process
  // happened to have cached since it started: under WORKERS > 1 every
  // worker accumulates its own view, so an admin's request landing on a
  // different worker each time would otherwise see numbers frozen at
  // whatever that worker first loaded. Low-frequency admin read, so the
  // extra disk round trip is not a concern the way it would be on the
  // per-message recording path below.
  await store.reload();
  return loadUsage();
}

export async function isTrackingEnabled() {
  await loadConfig();
  return trackingEnabled;
}

export async function getTrackingMode() {
  await loadConfig();
  return trackingMode;
}

export async function resetUsage() {
  await loadConfig();
  const fresh = createDefaultUsage();
  fresh.lastReset = now();
  store.replace(fresh);
  migrationChecked = true;
  await store.flush();
}
