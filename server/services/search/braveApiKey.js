// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Brave Search API key resolution.
 *
 * Extracted from `BraveSearchProvider` because two callers need it and they sit
 * on opposite sides of an import cycle: the provider, to authenticate a search,
 * and `toolLoader`, to decide whether `websearch.provider: "auto"` should offer
 * Brave or fall back to the keyless Qwant. Importing `WebSearchService` into
 * `toolLoader` for that one question closes the loop
 * `configCache → toolLoader → WebSearchService → qwantProvider →
 * requestThrottler → configCache`, and `WebSearchService` builds its singleton
 * at module scope, so whichever module is entered first hits a
 * temporal-dead-zone ReferenceError. This module holds functions only — no
 * module-scope work — so it is safe on either side.
 *
 * @module services/search/braveApiKey
 */

import { resolveBraveApiKey } from './websearchConfig.js';

/**
 * Resolve the Brave Search API key, in order:
 * 1. the credential the `websearch` installation references
 * 2. the `BRAVE_SEARCH_API_KEY` environment variable
 *
 * @returns {string|undefined} The key, or undefined when none is configured
 */
export function getBraveApiKey() {
  return resolveBraveApiKey();
}

/**
 * Whether Brave Search can run a query right now.
 * @returns {boolean}
 */
export function isBraveSearchConfigured() {
  return Boolean(getBraveApiKey());
}
