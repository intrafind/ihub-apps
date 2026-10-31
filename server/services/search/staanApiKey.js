// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Staan Search API key resolution.
 *
 * Split out of the provider for the same reason as `braveApiKey.js`: two
 * callers need the key and they sit on opposite sides of an import cycle — the
 * provider, to authenticate a search, and `toolLoader`, to decide whether
 * `websearch.provider: "auto"` can offer Staan. Importing `WebSearchService`
 * into `toolLoader` closes the loop `configCache → toolLoader →
 * WebSearchService → staanProvider → requestThrottler → configCache`, and
 * `WebSearchService` builds its singleton at module scope, so whichever module
 * is entered first hits a temporal-dead-zone ReferenceError. This module holds
 * functions only — no module-scope work — so it is safe on either side.
 *
 * @module services/search/staanApiKey
 */

import { resolveStaanApiKey } from './websearchConfig.js';

/**
 * Resolve the Staan Search API key, in order:
 * 1. the credential the `websearch` installation references
 * 2. the `STAAN_API_KEY` environment variable
 *
 * @returns {string|undefined} The key, or undefined when none is configured
 */
export function getStaanApiKey() {
  return resolveStaanApiKey();
}

/**
 * Whether Staan Search can run a query right now.
 * @returns {boolean}
 */
export function isStaanSearchConfigured() {
  return Boolean(getStaanApiKey());
}
