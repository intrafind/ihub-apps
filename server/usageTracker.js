import { recordTokenUsage } from './telemetry.js';
import { recordMagicPromptUsage, recordFeedbackEvent } from './telemetry/metrics.js';
import { resolveUserId } from './services/UserFingerprint.js';
import { logUsageEvent } from './services/UsageEventLog.js';
import { createSharedJsonFile } from './utils/sharedJsonFile.js';
import logger from './utils/logger.js';
import { estimateTokens as estimateTokensShared } from '../shared/tokenEstimator.js';
import { getContentsPath } from './utils/contentsPath.js';

const dataFile = getContentsPath('data', 'usage.json');
const now = () => new Date().toISOString();

let trackingEnabled = true;
let trackingMode = 'pseudonymous';
let configLoaded = false;

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

/**
 * Every cluster worker records usage, and each used to write its whole copy of
 * usage.json back, erasing what the others had counted since — and undoing an
 * admin's reset with the next save of a worker that still had the old numbers.
 *
 * Now each worker counts into `pending`, a usage object of zeros, and adds it
 * to the file on disk under a lock (see utils/sharedJsonFile.js). Counters
 * add up correctly whichever worker writes first; averages are recomputed
 * from the merged rating counts.
 */
const usageFile = createSharedJsonFile({
  filePath: dataFile,
  createDefault: createDefaultUsage,
  component: 'UsageTracker'
});

const FLUSH_INTERVAL_MS = 10000;

/** What this worker counted since its last flush, and since when. */
let pending = createDefaultUsage();
let pendingSince = Date.now();
let pendingDirty = false;
let flushTimer = null;
let flushInFlight = null;

function startPending() {
  pending = createDefaultUsage();
  pendingSince = Date.now();
  pendingDirty = false;
}

/**
 * Whether counts gathered since `since` predate the file's last reset. A
 * reset clears the file and the resetting worker's own counts; the other
 * workers learn of it here, and drop what they gathered before it rather
 * than adding it back. Counted between the reset and their next flush is
 * dropped with it — at most one flush interval.
 */
function resetSince(usage, since) {
  const resetAt = Date.parse(usage?.lastReset);
  return Number.isFinite(resetAt) && resetAt > since;
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Add every counter in `delta` to `target`, creating buckets `target` lacks
 * (a usage.json written before they existed). Strings (timestamps) and the
 * derived `averageRating` are left alone.
 */
function addCounters(target, delta) {
  for (const [key, value] of Object.entries(delta)) {
    if (UNSAFE_KEYS.has(key) || key === 'averageRating') continue;
    if (typeof value === 'number') {
      target[key] = (typeof target[key] === 'number' ? target[key] : 0) + value;
    } else if (value && typeof value === 'object') {
      if (!target[key] || typeof target[key] !== 'object') target[key] = {};
      addCounters(target[key], value);
    }
  }
}

/** Recompute each feedback bucket's average from its (merged) rating counts. */
function recomputeAverages(usage) {
  const feedback = usage.feedback;
  if (!feedback) return;
  const buckets = [feedback];
  for (const key of ['perUser', 'perApp', 'perModel']) {
    buckets.push(...Object.values(feedback[key] || {}));
  }
  for (const bucket of buckets) {
    if (bucket?.ratings) bucket.averageRating = computeAverageRating(bucket.ratings);
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushPending();
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref?.();
}

/** Add this worker's counts to usage.json. */
async function flushPending() {
  if (!pendingDirty) return;
  const delta = pending;
  const deltaSince = pendingSince;
  startPending();
  const flush = usageFile.update(data => {
    // Before normalizing, which stamps a missing lastReset with now.
    const staleDelta = resetSince(data, deltaSince);
    normalizeUsage(data);
    if (staleDelta) return;
    addCounters(data, delta);
    recomputeAverages(data);
    data.lastUpdated = now();
  });
  flushInFlight = flush;
  try {
    await flush;
  } catch (error) {
    // Keep the counts for the next attempt rather than losing them.
    addCounters(pending, delta);
    pendingSince = Math.min(pendingSince, deltaSince);
    pendingDirty = true;
    scheduleFlush();
    logger.error('Failed to save usage data', { component: 'UsageTracker', error });
  } finally {
    if (flushInFlight === flush) flushInFlight = null;
  }
}

/**
 * Write this worker's pending counts now, e.g. on shutdown, waiting for a
 * flush already under way as well.
 */
export async function flushUsage() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (flushInFlight) await flushInFlight.catch(() => {});
  await flushPending();
}

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

/** Bring a usage object read from disk up to the current feedback format. */
function normalizeUsage(data) {
  data.lastUpdated = data.lastUpdated || now();
  data.lastReset = data.lastReset || now();
  if (data.feedback) {
    migrateLegacyFeedback(data.feedback);
    // Migrate all nested feedback objects (perUser, perApp, perModel)
    ['perUser', 'perApp', 'perModel'].forEach(key => {
      if (data.feedback[key]) {
        Object.keys(data.feedback[key]).forEach(id => {
          migrateLegacyFeedback(data.feedback[key][id]);
        });
      }
    });
  }
}

/** The counters this worker records into; added to usage.json on flush. */
function loadUsage() {
  return pending;
}

function markDirty() {
  pendingDirty = true;
  scheduleFlush();
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
  const data = loadUsage();
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
  markDirty();
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
  const data = loadUsage();

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
  markDirty();
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
  const data = loadUsage();
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

  markDirty();
}

export async function getUsage() {
  await loadConfig();
  // The file as every worker has flushed it, plus what this worker counted
  // since its last flush.
  const usage = structuredClone(await usageFile.read());
  const pendingIsStale = resetSince(usage, pendingSince);
  normalizeUsage(usage);
  if (!pendingIsStale) addCounters(usage, pending);
  recomputeAverages(usage);
  return usage;
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
  // This worker's counts start at the reset itself, so they survive it;
  // other workers' older counts are dropped (see resetSince).
  const resetAt = new Date();
  startPending();
  pendingSince = resetAt.getTime();
  await usageFile.update(data => {
    for (const key of Object.keys(data)) delete data[key];
    Object.assign(data, createDefaultUsage(), { lastReset: resetAt.toISOString() });
  });
}
