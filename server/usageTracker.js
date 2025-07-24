import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
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
    contextUsage: {
      requests: { total: 0, perUser: {}, perApp: {}, perModel: {} },
      totalTokensUsed: 0,
      totalContextLimit: 0,
      averageUsagePercentage: 0,
      optimizationsApplied: { total: 0, perStrategy: {} },
      contextLimitExceeded: { total: 0, perUser: {}, perApp: {}, perModel: {} },
      recentUsage: [], // Keep last 100 requests for analysis
      breakdown: {
        systemPrompt: { total: 0, average: 0 },
        chatHistory: { total: 0, average: 0 },
        toolOutputs: { total: 0, average: 0 },
        additionalInput: { total: 0, average: 0 }
      }
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

export async function recordMagicPrompt({
  userId,
  appId,
  modelId,
  inputTokens = 0,
  outputTokens = 0
}) {
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

/**
 * Record context window usage for monitoring and analytics
 * @param {Object} params - Context usage parameters
 */
export async function recordContextUsage({
  userId,
  appId,
  modelId,
  totalTokens,
  contextLimit,
  usagePercentage,
  breakdown,
  optimization = null,
  exceedsLimit = false
}) {
  if (!trackingEnabled) return;
  
  const data = await loadUsage();
  const timestamp = now();
  
  // Record basic request metrics
  data.contextUsage.requests.total += 1;
  inc(data.contextUsage.requests.perUser, userId, 1);
  inc(data.contextUsage.requests.perApp, appId, 1);
  inc(data.contextUsage.requests.perModel, modelId, 1);
  
  // Update token usage totals
  data.contextUsage.totalTokensUsed += totalTokens;
  data.contextUsage.totalContextLimit += contextLimit;
  
  // Calculate running average usage percentage
  const totalRequests = data.contextUsage.requests.total;
  data.contextUsage.averageUsagePercentage = 
    ((data.contextUsage.averageUsagePercentage * (totalRequests - 1)) + usagePercentage) / totalRequests;
  
  // Record breakdown statistics
  if (breakdown) {
    ['systemPrompt', 'chatHistory', 'toolOutputs', 'additionalInput'].forEach(component => {
      if (breakdown[component] !== undefined) {
        data.contextUsage.breakdown[component].total += breakdown[component];
        data.contextUsage.breakdown[component].average = 
          data.contextUsage.breakdown[component].total / totalRequests;
      }
    });
  }
  
  // Record optimization events
  if (optimization && optimization.applied) {
    data.contextUsage.optimizationsApplied.total += 1;
    optimization.strategies.forEach(strategy => {
      inc(data.contextUsage.optimizationsApplied.perStrategy, strategy, 1);
    });
  }
  
  // Record context limit exceeded events
  if (exceedsLimit) {
    data.contextUsage.contextLimitExceeded.total += 1;
    inc(data.contextUsage.contextLimitExceeded.perUser, userId, 1);
    inc(data.contextUsage.contextLimitExceeded.perApp, appId, 1);
    inc(data.contextUsage.contextLimitExceeded.perModel, modelId, 1);
  }
  
  // Store recent usage for analysis (keep last 100)
  const usageRecord = {
    timestamp,
    userId,
    appId,
    modelId,
    totalTokens,
    contextLimit,
    usagePercentage: Math.round(usagePercentage * 10) / 10,
    breakdown: breakdown || {},
    optimization: optimization || null,
    exceedsLimit
  };
  
  data.contextUsage.recentUsage.push(usageRecord);
  if (data.contextUsage.recentUsage.length > 100) {
    data.contextUsage.recentUsage = data.contextUsage.recentUsage.slice(-100);
  }
  
  // Log context usage for monitoring
  console.log(`[CONTEXT] ${timestamp} - User: ${userId}, App: ${appId}, Model: ${modelId} - Usage: ${usagePercentage.toFixed(1)}% (${totalTokens}/${contextLimit} tokens)`);
  
  if (usagePercentage > 80) {
    console.warn(`[CONTEXT] High usage detected: ${usagePercentage.toFixed(1)}% for ${userId}/${appId}`);
  }
  
  if (optimization && optimization.applied) {
    console.info(`[CONTEXT] Optimization applied for ${userId}/${appId}: ${optimization.strategies.join(', ')} - saved ${optimization.tokensSaved} tokens`);
  }
  
  if (exceedsLimit) {
    console.error(`[CONTEXT] Context limit exceeded for ${userId}/${appId}: ${totalTokens}/${contextLimit} tokens`);
  }
  
  dirty = true;
  scheduleSave();
}

/**
 * Get context usage statistics
 * @param {Object} filters - Optional filters for specific data
 * @returns {Object} Context usage statistics
 */
export async function getContextUsageStats(filters = {}) {
  const data = await loadUsage();
  const contextData = data.contextUsage;
  
  // Apply filters if provided
  let recentUsage = contextData.recentUsage;
  if (filters.userId) {
    recentUsage = recentUsage.filter(record => record.userId === filters.userId);
  }
  if (filters.appId) {
    recentUsage = recentUsage.filter(record => record.appId === filters.appId);
  }
  if (filters.modelId) {
    recentUsage = recentUsage.filter(record => record.modelId === filters.modelId);
  }
  if (filters.sinceTimestamp) {
    recentUsage = recentUsage.filter(record => record.timestamp >= filters.sinceTimestamp);
  }
  
  // Calculate statistics from filtered data
  const totalRequests = recentUsage.length;
  const averageUsage = totalRequests > 0 
    ? recentUsage.reduce((sum, record) => sum + record.usagePercentage, 0) / totalRequests
    : 0;
  
  const highUsageRequests = recentUsage.filter(record => record.usagePercentage > 80).length;
  const exceededLimitRequests = recentUsage.filter(record => record.exceedsLimit).length;
  const optimizedRequests = recentUsage.filter(record => record.optimization && record.optimization.applied).length;
  
  return {
    overall: {
      totalRequests: contextData.requests.total,
      averageUsagePercentage: Math.round(contextData.averageUsagePercentage * 10) / 10,
      totalTokensUsed: contextData.totalTokensUsed,
      totalContextLimit: contextData.totalContextLimit,
      optimizationsApplied: contextData.optimizationsApplied.total,
      contextLimitExceeded: contextData.contextLimitExceeded.total
    },
    filtered: {
      totalRequests,
      averageUsagePercentage: Math.round(averageUsage * 10) / 10,
      highUsageRequests,
      exceededLimitRequests,
      optimizedRequests,
      optimizationRate: totalRequests > 0 ? Math.round((optimizedRequests / totalRequests) * 100) / 100 : 0
    },
    breakdown: contextData.breakdown,
    optimizationStrategies: contextData.optimizationsApplied.perStrategy,
    recentUsage: recentUsage.slice(-20) // Return last 20 for analysis
  };
}

/**
 * Check if context usage is trending upward (potential issue)
 * @param {string} userId - User ID to check
 * @param {string} appId - App ID to check  
 * @returns {Object} Trend analysis
 */
export async function analyzeContextUsageTrend(userId, appId) {
  const data = await loadUsage();
  const recentUsage = data.contextUsage.recentUsage
    .filter(record => (!userId || record.userId === userId) && (!appId || record.appId === appId))
    .slice(-20); // Last 20 requests
  
  if (recentUsage.length < 5) {
    return { 
      trend: 'insufficient_data', 
      message: 'Not enough data for trend analysis',
      recommendations: []
    };
  }
  
  // Calculate trend using simple linear regression
  const recent10 = recentUsage.slice(-10);
  const older10 = recentUsage.slice(-20, -10);
  
  const recentAvg = recent10.reduce((sum, r) => sum + r.usagePercentage, 0) / recent10.length;
  const olderAvg = older10.length > 0 
    ? older10.reduce((sum, r) => sum + r.usagePercentage, 0) / older10.length
    : recentAvg;
  
  const trendDirection = recentAvg - olderAvg;
  const highUsageCount = recent10.filter(r => r.usagePercentage > 80).length;
  const optimizationCount = recent10.filter(r => r.optimization && r.optimization.applied).length;
  
  let trend, message, recommendations = [];
  
  if (trendDirection > 10) {
    trend = 'increasing_rapidly';
    message = `Context usage increasing rapidly: ${olderAvg.toFixed(1)}% → ${recentAvg.toFixed(1)}%`;
    recommendations = [
      'Consider implementing automatic context optimization',
      'Review recent conversations for unnecessary content',
      'Use summarization for large inputs or tool outputs'
    ];
  } else if (trendDirection > 5) {
    trend = 'increasing';
    message = `Context usage trending upward: ${olderAvg.toFixed(1)}% → ${recentAvg.toFixed(1)}%`;
    recommendations = [
      'Monitor context usage closely',
      'Consider periodic conversation cleanup'
    ];
  } else if (trendDirection < -5) {
    trend = 'decreasing';
    message = `Context usage trending downward: ${olderAvg.toFixed(1)}% → ${recentAvg.toFixed(1)}%`;
    recommendations = ['Current usage patterns are sustainable'];
  } else {
    trend = 'stable';
    message = `Context usage stable: ~${recentAvg.toFixed(1)}%`;
    recommendations = ['Current usage patterns are sustainable'];
  }
  
  if (highUsageCount > 5) {
    recommendations.push('Frequent high usage detected - enable automatic optimization');
  }
  
  return {
    trend,
    message,
    recommendations,
    statistics: {
      recentAverage: Math.round(recentAvg * 10) / 10,
      olderAverage: Math.round(olderAvg * 10) / 10,
      trendDirection: Math.round(trendDirection * 10) / 10,
      highUsageCount,
      optimizationCount,
      dataPoints: recentUsage.length
    }
  };
}
