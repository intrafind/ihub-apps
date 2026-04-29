/**
 * Request throttling utility supporting per-model and per-tool limits.
 * Keeps an in-memory queue for each identifier so provider rate limits are not exceeded.
 */
import configCache from './configCache.js';
import { httpFetch } from './utils/httpConfig.js';
import { recordRateLimitHit } from './telemetry/metrics.js';

const lastCompleted = new Map(); // id -> timestamp when last request finished

const queues = new Map(); // id -> array of pending tasks
const actives = new Map(); // id -> number of active requests

// Any configured value below 1 disables throttling (treated as unlimited)

function normalizeLimit(value) {
  return typeof value === 'number' && value >= 1 ? value : Infinity;
}

function getConcurrency(id = 'default') {
  const platform = configCache.getPlatform() || {};
  const { data: models = [] } = configCache.getModels() || {};
  const { data: tools = [] } = configCache.getTools() || {};
  const model = models.find(m => m.id === id);
  if (model && typeof model.concurrency === 'number') return normalizeLimit(model.concurrency);
  const tool = tools.find(t => t.id === id);
  if (tool && typeof tool.concurrency === 'number') return normalizeLimit(tool.concurrency);
  const limit = platform.requestConcurrency;
  return normalizeLimit(limit);
}

function getDelay(id = 'default') {
  const platform = configCache.getPlatform() || {};
  const { data: models = [] } = configCache.getModels() || {};
  const { data: tools = [] } = configCache.getTools() || {};
  const model = models.find(m => m.id === id);
  if (model && typeof model.requestDelayMs === 'number') return model.requestDelayMs;
  const tool = tools.find(t => t.id === id);
  if (tool && typeof tool.requestDelayMs === 'number') return tool.requestDelayMs;
  return typeof platform.requestDelayMs === 'number' ? platform.requestDelayMs : 0;
}

export function throttledFetch(id, url, options = {}) {
  if (typeof url === 'undefined') {
    // called as throttledFetch(url)
    url = id;
    id = 'default';
  }
  if (!queues.has(id)) {
    queues.set(id, []);
    actives.set(id, 0);
  }

  const queue = queues.get(id);

  return new Promise((resolve, reject) => {
    const execute = async () => {
      actives.set(id, actives.get(id) + 1);
      try {
        const delay = getDelay(id);
        const lastTime = lastCompleted.get(id) || 0;
        const wait = Math.max(0, delay - (Date.now() - lastTime));
        if (wait > 0) {
          await new Promise(r => setTimeout(r, wait));
        }

        const res = await httpFetch(url, options);
        resolve(res);
      } catch (error) {
        reject(error);
      } finally {
        actives.set(id, actives.get(id) - 1);
        lastCompleted.set(id, Date.now());
        if (queue.length > 0) {
          const next = queue.shift();
          next();
        }
      }
    };

    if (actives.get(id) < getConcurrency(id)) {
      execute();
    } else {
      // The request had to wait for a slot - that's a throttler hit. We use
      // the "llm" scope because all current callers are LLM/tool calls.
      // Pass id as the "route" so dashboards can group by model id.
      recordRateLimitHit('llm', id);
      queue.push(execute);
    }
  });
}
