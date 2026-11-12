// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Rate-limit demand: which limiter each request counts against (mirrors the
 * mounts in server/middleware/setup.js and the credential-path rule in
 * server/middleware/rateLimiting.js), counted per user and per runner (= one
 * client IP) per minute. The report sets this real demand against the
 * configured limits, so we can tell whether the limits fit how iHub is used.
 */

const PUBLIC_PREFIXES = [
  'apps',
  'chats',
  'scheduled-tasks',
  'shares',
  'users',
  'tools',
  'mcp-apps',
  'models',
  'prompts',
  'projects',
  'styles',
  'translations',
  'configs',
  'sessions',
  'pages',
  'magic-prompt',
  'shortlinks',
  'integrations',
  'eu-ai-act',
  'auth'
];
const READ_ONLY_AUTH = new Set([
  '/status',
  '/user',
  '/logout',
  '/oidc-logout',
  '/teams/client-config'
]);

/**
 * Limiters a request counts against. `path` starts at /api (base path removed).
 * @returns {string[]}
 */
export function limitersFor(method, path) {
  const p = path.split('?')[0];
  const m = /^\/api\/([^/]+)(\/.*)?$/.exec(p);
  if (!m) return [];
  const [, top, rest = ''] = m;
  if (top === 'admin') return ['adminApi'];
  if (top === 'inference' || (top === 'voice' && rest.startsWith('/speech')))
    return ['inferenceApi'];
  if (top === 'oauth') return ['oauthApi'];
  if (top === 'auth') {
    const sub = rest.length > 1 && rest.endsWith('/') ? rest.slice(0, -1) : rest;
    const readOnly = READ_ONLY_AUTH.has(sub) || (method === 'GET' && sub.startsWith('/oidc/'));
    return readOnly ? ['publicApi'] : ['publicApi', 'authApi'];
  }
  if (PUBLIC_PREFIXES.includes(top)) return ['publicApi'];
  return ['unlimited'];
}

/**
 * Counts requests per (user, limiter) and per limiter for this runner, and
 * files per-minute totals as trends once a minute:
 *   rl.<limiter>.perUserMin    requests one active user sent in a minute
 *   rl.<limiter>.perRunnerMin  requests this runner (one client IP) sent in a minute
 * plus counters rl.<limiter>.total and rl.<limiter>.429.
 */
export class RateTracker {
  constructor(metrics, basePath = '') {
    this.metrics = metrics;
    this.basePath = basePath.replace(/\/+$/, '');
    this.users = new Map(); // user -> Map(limiter -> n)
    this.runner = new Map(); // limiter -> n
    this.timer = setInterval(() => this.flush(), 60_000);
    this.timer.unref?.();
  }

  record(user, method, url, status) {
    let path = url.replace(/^https?:\/\/[^/]+/, '');
    if (this.basePath && path.startsWith(this.basePath)) path = path.slice(this.basePath.length);
    for (const lim of limitersFor(method, path)) {
      const u = this.users.get(user) || new Map();
      u.set(lim, (u.get(lim) || 0) + 1);
      this.users.set(user, u);
      this.runner.set(lim, (this.runner.get(lim) || 0) + 1);
      this.metrics.count(`rl.${lim}.total`);
      if (status === 429) this.metrics.count(`rl.${lim}.429`);
    }
  }

  flush() {
    const limiters = new Set(this.runner.keys());
    for (const u of this.users.values()) {
      for (const lim of limiters) this.metrics.trend(`rl.${lim}.perUserMin`, u.get(lim) || 0);
    }
    for (const [lim, n] of this.runner) this.metrics.trend(`rl.${lim}.perRunnerMin`, n);
    this.users.clear();
    this.runner.clear();
  }

  stop() {
    clearInterval(this.timer);
  }
}
