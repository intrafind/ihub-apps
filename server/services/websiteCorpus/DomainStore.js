// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Which company-internal websites the Website Corpus may reach.
 *
 * The SSRF guard refuses private and internal addresses, so an intranet site
 * cannot be sized until someone says it may be. A user whose crawl was refused
 * can **request** the host; an admin **approves** or **declines** it (or adds a
 * host directly, with a wildcard such as `*.corp.example`). An approval lets the
 * Website Corpus reach that host's company-internal address; it does not touch
 * the platform-wide `ssrf.allowedHosts`, so `read_url` and the workflows keep
 * the public-addresses-only rule.
 *
 * One document per host, keyed by a hash of the host: however many users ask
 * for one host, there is one request, and a decision applies to all of them.
 *
 * @module services/websiteCorpus/DomainStore
 */
import crypto from 'node:crypto';
import { getStorage, readFacet } from '../../storage/bootstrap.js';
import { RUNTIME_NAMESPACES } from '../../storage/namespaces.js';
import { isDomainWhitelisted } from '../../utils/httpConfig.js';
import { nonDefaultPort } from './urls.js';

export const DOMAINS_NAMESPACE = RUNTIME_NAMESPACES.websiteCorpusDomains;

export const DOMAIN_STATUSES = Object.freeze({
  REQUESTED: 'requested',
  APPROVED: 'approved',
  DECLINED: 'declined'
});

/** Bounds: what a user may write, how many requests stay open, how many hosts are kept. */
export const MAX_REASON_CHARS = 500;
export const MAX_NOTE_CHARS = 500;
export const MAX_REQUESTERS_PER_HOST = 20;
export const MAX_OPEN_REQUESTS_PER_USER = 10;
export const MAX_DOMAINS = 500;
const MAX_HOST_CHARS = 253;

/** How long the approved hosts are kept in memory before they are read again. */
const APPROVED_TTL_MS = 30_000;

const LOCK_OPTIONS = { ttlMs: 15_000, waitMs: 5_000 };

/** An error the connector and the admin routes turn into a message. */
export class DomainError extends Error {
  /**
   * @param {'INVALID_HOST'|'TOO_MANY_REQUESTS'|'NOT_FOUND'|'STORAGE_UNAVAILABLE'|'INVALID_TEXT'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

/** The id of a host's document. */
export function domainIdFor(host) {
  return `wd_${crypto.createHash('sha256').update(host).digest('hex').slice(0, 32)}`;
}

export const isDomainId = value => typeof value === 'string' && /^wd_[a-f0-9]{32}$/.test(value);

const HOST_NAME = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const IPV6_LITERAL = /^[0-9a-f:.]+$/;

/**
 * Split a stored host into its name and its port (`''` for none). An IPv6 literal
 * has no port.
 *
 * @param {string} host - `name` or `name:port`
 * @returns {{name: string, port: string}}
 */
export function splitHost(host) {
  const match = /^([^:]+):(\d{1,5})$/.exec(host);
  return match ? { name: match[1], port: match[2] } : { name: host, port: '' };
}

/**
 * A host as it is stored: a lower-case host name or IP address, with a port only
 * when it is not 80 or 443, without scheme or path. A full http(s) URL is
 * reduced to its host. `*.example.corp` is accepted only with `allowWildcard`
 * (an admin's entry, never a user's request). Only letters, digits, `.`, `-` and
 * `_` are accepted, so what is stored is what was checked.
 *
 * @param {string} input
 * @param {{allowWildcard?: boolean}} [options]
 * @returns {string}
 * @throws {DomainError} `INVALID_HOST`
 */
export function normalizeHost(input, { allowWildcard = false } = {}) {
  const fail = message => new DomainError('INVALID_HOST', message);
  const text = String(input ?? '').trim();
  if (!text) throw fail('The host is empty');
  if (text.length > 2 * MAX_HOST_CHARS) throw fail('The host is too long');
  if (text.startsWith('*.')) {
    if (!allowWildcard) throw fail('Ask for one host, not a pattern such as *.example.corp');
    const rest = normalizeHost(text.slice(2));
    if (!splitHost(rest).name.includes('.'))
      throw fail('A wildcard needs a domain below it, such as *.example.corp');
    return `*.${rest}`;
  }
  let url;
  try {
    url = new URL(text.includes('://') ? text : `https://${text}`);
  } catch {
    throw fail(`"${text.slice(0, 80)}" is not a valid host name`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw fail('Give a host name, or an http(s) address');
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const isIpv6 = hostname.includes(':');
  const valid = isIpv6
    ? IPV6_LITERAL.test(hostname)
    : HOST_NAME.test(hostname) && !hostname.includes('..');
  if (!valid || hostname.length > MAX_HOST_CHARS) {
    throw fail(
      `"${text.slice(0, 80)}" is not a valid host name: use letters, digits, dots and hyphens`
    );
  }
  const port = isIpv6 ? '' : nonDefaultPort(url.port);
  return port ? `${hostname}:${port}` : hostname;
}

function cleanText(value, max, what) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new DomainError('INVALID_TEXT', `${what} must be text`);
  const text = value.trim();
  if (text.length > max)
    throw new DomainError('INVALID_TEXT', `${what} must be at most ${max} characters`);
  return text || null;
}

const personOf = user => ({ id: user.id, name: user.name || user.id });

export class DomainStore {
  /**
   * @param {{documents: Object, locks?: Object}} [facets] - Storage facets; the active provider's by default
   */
  constructor({ documents = null, locks = null } = {}) {
    this.documents = documents;
    this.locks = locks;
    this.approvedCache = null;
    this.generation = 0;
  }

  isAvailable() {
    return Boolean(this.documents);
  }

  _require() {
    if (!this.isAvailable()) {
      throw new DomainError(
        'STORAGE_UNAVAILABLE',
        'Requests for websites cannot be kept: the storage provider has no document store'
      );
    }
  }

  _locked(id, fn) {
    return this.locks ? this.locks.withLock(`website-corpus-domain:${id}`, fn, LOCK_OPTIONS) : fn();
  }

  async _read(id) {
    const doc = await this.documents.get(DOMAINS_NAMESPACE, id);
    return doc?.data || null;
  }

  /** The approved hosts are read again: the list changed, here and (after the cache time) elsewhere. */
  _changed() {
    this.generation += 1;
    this.approvedCache = null;
  }

  async _write(entry) {
    const body = { ...entry, updatedAt: new Date().toISOString() };
    try {
      await this.documents.put(DOMAINS_NAMESPACE, entry.id, body, { ownerId: entry.ownerId });
    } finally {
      this._changed();
    }
    return body;
  }

  /** The entry for one host, or `null`. */
  async find(host) {
    this._require();
    return this._read(domainIdFor(normalizeHost(host, { allowWildcard: true })));
  }

  /** One entry by id, or `null`. */
  async get(id) {
    this._require();
    return isDomainId(id) ? this._read(id) : null;
  }

  /**
   * A user's request for a host. A host that was requested before gets one more
   * requester; an approved or declined one is returned as it is.
   *
   * @param {{host: string, user: {id: string, name?: string}, reason?: string}} input
   * @returns {Promise<{entry: Object, created: boolean}>}
   */
  async request({ host, user, reason }) {
    this._require();
    const name = normalizeHost(host);
    const why = cleanText(reason, MAX_REASON_CHARS, 'The reason');
    const id = domainIdFor(name);
    return this._locked(id, async () => {
      const existing = await this._read(id);
      const now = new Date().toISOString();
      if (existing) {
        if (existing.status !== DOMAIN_STATUSES.REQUESTED)
          return { entry: existing, created: false };
        if (existing.requesters.some(entry => entry.userId === user.id)) {
          return { entry: existing, created: false };
        }
        const requesters = [
          ...existing.requesters,
          { userId: user.id, name: personOf(user).name, reason: why, at: now }
        ].slice(-MAX_REQUESTERS_PER_HOST);
        return { entry: await this._write({ ...existing, requesters }), created: false };
      }
      // One lock per user, so parallel requests for different hosts cannot all pass the limit.
      const userKey = `u_${crypto.createHash('sha256').update(String(user.id)).digest('hex').slice(0, 24)}`;
      return this._locked(userKey, async () => {
        const open = await this._openRequestsOf(user.id);
        if (open >= MAX_OPEN_REQUESTS_PER_USER) {
          throw new DomainError(
            'TOO_MANY_REQUESTS',
            `You already have ${open} open requests for websites. Wait for an admin to decide on some of them.`
          );
        }
        return this._create({ id, name, user, why, now });
      });
    });
  }

  async _openRequestsOf(userId) {
    let open = 0;
    let cursor = null;
    do {
      const page = await this.documents.list(DOMAINS_NAMESPACE, {
        ownerId: userId,
        limit: 200,
        ...(cursor ? { cursor } : {})
      });
      for (const doc of page.items || []) {
        if (doc.data?.status === DOMAIN_STATUSES.REQUESTED && doc.data.ownerId === userId)
          open += 1;
      }
      cursor = page.nextCursor || null;
    } while (cursor);
    return open;
  }

  async _create({ id, name, user, why, now }) {
    const entry = {
      id,
      host: name,
      status: DOMAIN_STATUSES.REQUESTED,
      source: 'request',
      ownerId: user.id,
      requesters: [{ userId: user.id, name: personOf(user).name, reason: why, at: now }],
      createdAt: now,
      decidedBy: null,
      decidedAt: null,
      note: null
    };
    return { entry: await this._write(entry), created: true };
  }

  /**
   * An admin adds a host that is approved at once (wildcards allowed).
   *
   * @param {{host: string, admin: {id: string, name?: string}, note?: string}} input
   * @returns {Promise<Object>} The entry
   */
  async addApproved({ host, admin, note }) {
    this._require();
    const name = normalizeHost(host, { allowWildcard: true });
    const id = domainIdFor(name);
    const text = cleanText(note, MAX_NOTE_CHARS, 'The note');
    return this._locked(id, async () => {
      const existing = await this._read(id);
      const now = new Date().toISOString();
      return this._write({
        requesters: [],
        createdAt: now,
        source: 'admin',
        ownerId: admin.id,
        ...(existing || {}),
        id,
        host: name,
        status: DOMAIN_STATUSES.APPROVED,
        decidedBy: personOf(admin),
        decidedAt: now,
        note: text
      });
    });
  }

  /**
   * An admin's decision on an entry. Either decision may follow the other: an
   * approval can be withdrawn and a refusal reversed.
   *
   * @param {string} id
   * @param {{decision: 'approved'|'declined', admin: {id: string, name?: string}, note?: string}} input
   * @returns {Promise<Object>} The entry
   * @throws {DomainError} `NOT_FOUND`
   */
  async decide(id, { decision, admin, note }) {
    this._require();
    const text = cleanText(note, MAX_NOTE_CHARS, 'The note');
    return this._locked(id, async () => {
      const existing = isDomainId(id) ? await this._read(id) : null;
      if (!existing) throw new DomainError('NOT_FOUND', 'No such request');
      return this._write({
        ...existing,
        status: decision,
        decidedBy: personOf(admin),
        decidedAt: new Date().toISOString(),
        note: text
      });
    });
  }

  /** Remove an entry (an approval is withdrawn, a refusal forgotten). */
  async remove(id) {
    this._require();
    if (!isDomainId(id)) return false;
    return this._locked(id, async () => {
      try {
        return await this.documents.delete(DOMAINS_NAMESPACE, id);
      } finally {
        this._changed();
      }
    });
  }

  /**
   * One page of entries, open requests first.
   *
   * @param {{limit?: number, cursor?: string|null}} [options]
   * @returns {Promise<{items: Object[], nextCursor: string|null}>}
   */
  async list({ limit = 100, cursor = null } = {}) {
    this._require();
    const page = await this.documents.list(DOMAINS_NAMESPACE, {
      limit: Math.min(Math.max(Number(limit) || 100, 1), 200),
      ...(cursor ? { cursor } : {})
    });
    const order = { requested: 0, approved: 1, declined: 2 };
    const items = (page.items || [])
      .map(doc => doc.data)
      .filter(Boolean)
      .sort(
        (a, b) =>
          order[a.status] - order[b.status] ||
          String(b.updatedAt).localeCompare(String(a.updatedAt))
      );
    return { items, nextCursor: page.nextCursor || null };
  }

  /** How many requests wait for a decision. */
  async openCount() {
    let open = 0;
    let cursor = null;
    do {
      const page = await this.documents.list(DOMAINS_NAMESPACE, {
        limit: 200,
        ...(cursor ? { cursor } : {})
      });
      for (const doc of page.items || []) {
        if (doc.data?.status === DOMAIN_STATUSES.REQUESTED) open += 1;
      }
      cursor = page.nextCursor || null;
    } while (cursor);
    return open;
  }

  /**
   * The approved hosts and patterns, kept for a short while in memory so a
   * crawl does not read the store for every request.
   *
   * @returns {Promise<string[]>}
   */
  async approvedHosts(now = Date.now()) {
    if (!this.isAvailable()) return [];
    if (this.approvedCache && now - this.approvedCache.at < APPROVED_TTL_MS) {
      return this.approvedCache.hosts;
    }
    const generation = this.generation;
    const hosts = [];
    let cursor = null;
    do {
      const page = await this.documents.list(DOMAINS_NAMESPACE, {
        limit: 200,
        ...(cursor ? { cursor } : {})
      });
      for (const doc of page.items || []) {
        if (doc.data?.status === DOMAIN_STATUSES.APPROVED) hosts.push(doc.data.host);
      }
      cursor = page.nextCursor || null;
    } while (cursor && hosts.length < MAX_DOMAINS);
    if (generation === this.generation) this.approvedCache = { at: now, hosts };
    return hosts;
  }

  /**
   * Whether an approved host or pattern covers `hostname` on `port`, given a list
   * from {@link approvedHosts}. An approval names a host and, unless it ends in a
   * port, means its ports 80 and 443 only: a service on another port of the same
   * machine is not the website that was approved.
   *
   * @param {string[]} hosts
   * @param {string} hostname - Without brackets
   * @param {string} [port] - The URL's port; empty for the scheme's default
   */
  static covers(hosts, hostname, port = '') {
    const wanted = nonDefaultPort(port);
    const patterns = [];
    for (const host of hosts) {
      const entry = splitHost(host);
      if (entry.port === wanted) patterns.push(entry.name);
    }
    return isDomainWhitelisted(hostname, patterns);
  }
}

let defaultStore = null;

/** The store on the active storage provider. */
export function getDomainStore() {
  const provider = getStorage();
  if (!defaultStore || defaultStore.provider !== provider) {
    defaultStore = new DomainStore({
      documents: readFacet(provider, 'documents'),
      locks: readFacet(provider, 'locks')
    });
    defaultStore.provider = provider;
  }
  return defaultStore;
}
