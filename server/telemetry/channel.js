// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Which client a request came through: the web app, the Office add-in, the
 * browser extension, Teams, Nextcloud, an MCP or A2A client, or the
 * OpenAI-compatible API.
 *
 * Decided from what the server knows for certain — the route and the OAuth
 * client the request authenticated with — never from a header the client
 * sends about itself. The value is a closed set ({@link CLIENT_CHANNELS}), so it
 * can be a metric label (`ihub.client.channel`): "is the Outlook add-in used?"
 * becomes a query.
 *
 * The Office add-in runs in Outlook, Word, Excel and PowerPoint with one OAuth
 * client; the server cannot tell the host apart, so all of them are `office`.
 *
 * @module telemetry/channel
 */

import { getContext } from '../utils/requestContext.js';

/** The channels a request can come through. */
export const CLIENT_CHANNELS = Object.freeze([
  'web',
  'office',
  'browser_extension',
  'teams',
  'nextcloud',
  'mcp',
  'a2a',
  'openai_proxy',
  'system'
]);

/** Route prefixes (after the base path) that decide the channel by themselves. */
const ROUTE_CHANNELS = [
  [/\/api\/inference\//, 'openai_proxy'],
  [/\/a2a(\/|$)/, 'a2a'],
  [/\/mcp(\/|$)/, 'mcp']
];

/**
 * The channel of a request.
 *
 * @param {Object} input
 * @param {string} [input.path] - The request path
 * @param {string} [input.oauthClientId] - The OAuth client it authenticated with
 * @param {string} [input.authMode] - The user's auth mode (`teams`, `local`, …)
 * @param {Object} [input.platform] - platform.json (the add-in client ids)
 * @returns {string} One of {@link CLIENT_CHANNELS}
 */
export function clientChannelOf({ path, oauthClientId, authMode, platform } = {}) {
  if (typeof path === 'string') {
    for (const [pattern, channel] of ROUTE_CHANNELS) {
      if (pattern.test(path)) return channel;
    }
  }
  if (authMode === 'teams') return 'teams';
  if (oauthClientId && platform) {
    if (oauthClientId === platform.officeIntegration?.oauthClientId) return 'office';
    if (oauthClientId === platform.browserExtension?.oauthClientId) return 'browser_extension';
    if (oauthClientId === platform.nextcloudEmbed?.oauthClientId) return 'nextcloud';
  }
  return 'web';
}

/**
 * The channel of the request being handled, from the request context; `system`
 * outside a request (a scheduled task, a background job).
 *
 * @param {Object} [options]
 * @param {Object} [options.user] - The request's user (for its auth mode)
 * @param {Object} [options.platform] - platform.json
 * @returns {string}
 */
export function currentClientChannel({ user, platform } = {}) {
  const ctx = getContext();
  if (!ctx) return 'system';
  return clientChannelOf({
    path: ctx.channelPath,
    oauthClientId: ctx.oauthClientId,
    authMode: user?.authMode,
    platform
  });
}
