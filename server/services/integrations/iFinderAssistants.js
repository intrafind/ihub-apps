// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * iFinder iAssistants (`/public-api/v0/assistants`, iFinder 6.8+).
 *
 * An iAssistant is iFinder's pairing of a conversation profile (how the
 * assistant works) with a search profile (which documents it searches), with a
 * localized name and description. iFinder only shows a user the iAssistants
 * whose search profile they have: the list leaves the others out, and reading
 * one of them answers 404, exactly as for an id that does not exist.
 *
 * An app that names an iAssistant therefore gets both profiles from one id,
 * and gets them for the requesting user — iHub reads the iAssistant as that
 * user when it creates a conversation.
 */
import { throttledFetch } from '../../requestThrottler.js';
import iFinderTokenProvider from './iFinderTokenProvider.js';
import logger from '../../utils/logger.js';

export const ASSISTANTS_PATH = '/public-api/v0/assistants';

/** How long an iAssistant read for a user is kept when the caller passes no TTL. */
export const DEFAULT_CACHE_TTL_MS = 300000;

/** Largest page iFinder serves; iHub reads every page up to `MAX_PAGES`. */
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

/** An iAssistant iFinder does not offer this user (or that does not exist). */
export class AssistantNotAvailableError extends Error {
  constructor(assistantId) {
    super(`The iFinder iAssistant "${assistantId}" is not available to this user`);
    this.name = 'AssistantNotAvailableError';
    this.assistantId = assistantId;
  }
}

/**
 * An iAssistant as iHub uses it.
 * @param {Object} raw - an `AssistantLocalized`
 * @returns {{id: string, name: string, description: string|null,
 *   conversationProfileId: string|null, searchProfileId: string|null}|null}
 */
export function toAssistant(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) return null;
  const text = value => (typeof value === 'string' && value.trim() ? value.trim() : null);
  return {
    id: raw.id,
    name: text(raw.name) || raw.id,
    description: text(raw.description),
    conversationProfileId: text(raw.conversation_profile_id),
    searchProfileId: text(raw.search_profile_id)
  };
}

class IFinderAssistants {
  constructor() {
    /** @type {Map<string, { value: Object, expiresAt: number }>} */
    this.cache = new Map();
    this.fetch = throttledFetch;
  }

  /** Drop every cached read. Called from the config reload hooks. */
  reset() {
    this.cache.clear();
  }

  /**
   * One iAssistant as the user sees it, cached per user.
   *
   * @param {Object} params
   * @param {string} params.assistantId
   * @param {Object} params.user - authenticated user; the request is made as them
   * @param {string} params.baseUrl - iFinder base URL
   * @param {number} [params.ttlMs]
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<ReturnType<typeof toAssistant>>}
   * @throws {AssistantNotAvailableError} when iFinder does not offer it to the user
   */
  async getAssistant({ assistantId, user, baseUrl, ttlMs = DEFAULT_CACHE_TTL_MS, signal }) {
    if (!user?.id || user.id === 'anonymous') {
      throw new Error('iFinder iAssistants can only be read for a signed-in user');
    }
    if (!baseUrl) throw new Error('No iFinder base URL configured');

    const key = `${baseUrl}::${user.id}::${assistantId}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const response = await this.request({
      url: `${baseUrl.replace(/\/+$/, '')}${ASSISTANTS_PATH}/${encodeURIComponent(assistantId)}`,
      user,
      signal
    });
    if (response.status === 404) throw new AssistantNotAvailableError(assistantId);
    await this.ensureOk(response, 'Reading the iFinder iAssistant');

    const assistant = toAssistant(await response.json());
    if (!assistant) throw new Error('iFinder answered with an unreadable iAssistant');
    this.cache.set(key, { value: assistant, expiresAt: Date.now() + ttlMs });
    return assistant;
  }

  /**
   * Every iAssistant iFinder offers the user, with names in `language`.
   *
   * @param {Object} params
   * @param {Object} params.user
   * @param {string} params.baseUrl
   * @param {string} [params.language] - sent as Accept-Language
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<Array<ReturnType<typeof toAssistant>>>}
   */
  async listAssistants({ user, baseUrl, language, signal }) {
    if (!user?.id || user.id === 'anonymous') {
      throw new Error('iFinder iAssistants can only be listed for a signed-in user');
    }
    if (!baseUrl) throw new Error('No iFinder base URL configured');

    const assistants = [];
    let cursor = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const params = new URLSearchParams({ size: String(PAGE_SIZE) });
      if (cursor) params.set('next_cursor', cursor);
      const response = await this.request({
        url: `${baseUrl.replace(/\/+$/, '')}${ASSISTANTS_PATH}?${params}`,
        user,
        language,
        signal
      });
      await this.ensureOk(response, 'Listing the iFinder iAssistants');
      const data = await response.json();
      for (const raw of Array.isArray(data?.assistants) ? data.assistants : []) {
        const assistant = toAssistant(raw);
        if (assistant) assistants.push(assistant);
      }
      cursor = typeof data?.next_cursor === 'string' && data.next_cursor ? data.next_cursor : null;
      if (!cursor) break;
    }

    logger.debug('Listed the iFinder iAssistants of a user', {
      component: 'IFinderAssistants',
      count: assistants.length
    });
    return assistants;
  }

  /** @private */
  async request({ url, user, language, signal }) {
    return this.fetch('iFinderAssistants', url, {
      method: 'GET',
      headers: {
        Authorization: await iFinderTokenProvider.getAuthorizationHeader(user),
        Accept: 'application/json',
        ...(language ? { 'Accept-Language': language } : {})
      },
      ...(signal ? { signal } : {})
    });
  }

  /** @private */
  async ensureOk(response, what) {
    if (response.ok) return;
    const errorText = await response.text().catch(() => '');
    throw new Error(`${what} failed (${response.status}): ${errorText.slice(0, 200)}`);
  }
}

export default new IFinderAssistants();
