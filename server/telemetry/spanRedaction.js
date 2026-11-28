// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The last check before a span leaves the process.
 *
 * Our own spans pass the attribute filter of `spans.js`. Spans of the HTTP,
 * undici and Express instrumentations do not: they record the inbound query
 * string (which carries the OIDC callback `code` and `state`), the outbound
 * URL with any `token`, `key` or signature parameter, the client's IP address,
 * and exception events whose message can quote a URL.
 *
 * {@link RedactingSpanProcessor} sits in front of the exporting processor and
 * rewrites every finished span in place:
 *
 * - `url.full` / `http.url`: user info, query and fragment removed;
 *   `http.target`: query removed; `url.query`: dropped;
 * - on SERVER spans the caller's address (`client.address`, `http.client_ip`,
 *   `network.peer.address`, …) is dropped: an employee's IP is an identity;
 * - forbidden attributes (groups, e-mail, error messages, auth headers) dropped;
 * - exception events lose message and stack, and the status message is
 *   cleared, unless `spans.includeOptInAttributes` is on.
 *
 * @module telemetry/spanRedaction
 */

import { SpanKind } from '@opentelemetry/api';

/** Attributes holding a full URL. */
const FULL_URL_ATTRIBUTES = ['url.full', 'http.url'];

/** Attributes holding a path with an optional query. */
const TARGET_ATTRIBUTES = ['http.target'];

/** Attributes removed from every span. */
const DROPPED_ATTRIBUTES = [
  'url.query',
  'user.groups',
  'user.email',
  'user.name',
  'user.full_name',
  'enduser.id',
  'error.message',
  'http.request.header.authorization',
  'http.request.header.cookie',
  'http.response.header.set-cookie'
];

/** Attributes removed from SERVER spans: the caller's address. */
const CALLER_ADDRESS_ATTRIBUTES = [
  'client.address',
  'client.port',
  'http.client_ip',
  'network.peer.address',
  'network.peer.port',
  'net.peer.ip',
  'net.peer.port',
  'net.sock.peer.addr',
  'net.sock.peer.port'
];

/**
 * A URL without user info, query string and fragment. A value that is not a
 * parseable absolute URL is cut at the first `?` or `#`.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function stripUrl(value) {
  if (typeof value !== 'string') return value;
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return stripQuery(value);
  }
}

/**
 * A path without its query string and fragment.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function stripQuery(value) {
  if (typeof value !== 'string') return value;
  const cut = value.search(/[?#]/);
  return cut === -1 ? value : value.slice(0, cut);
}

/**
 * Rewrite the attributes of one finished span in place.
 *
 * @param {import('@opentelemetry/sdk-trace').ReadableSpan} span
 * @param {{includeOptInAttributes?: boolean}} [options]
 */
export function redactSpan(span, { includeOptInAttributes = false } = {}) {
  const attributes = span?.attributes;
  if (attributes && typeof attributes === 'object') {
    for (const key of FULL_URL_ATTRIBUTES) {
      if (key in attributes) attributes[key] = stripUrl(attributes[key]);
    }
    for (const key of TARGET_ATTRIBUTES) {
      if (key in attributes) attributes[key] = stripQuery(attributes[key]);
    }
    for (const key of DROPPED_ATTRIBUTES) delete attributes[key];
    if (span.kind === SpanKind.SERVER) {
      for (const key of CALLER_ADDRESS_ATTRIBUTES) delete attributes[key];
    }
  }
  if (!includeOptInAttributes) {
    for (const event of span?.events ?? []) {
      if (event?.name !== 'exception' || !event.attributes) continue;
      delete event.attributes['exception.message'];
      delete event.attributes['exception.stacktrace'];
    }
    if (span?.status?.message) span.status.message = undefined;
  }
}

/**
 * A span processor that redacts every span ({@link redactSpan}) before it
 * hands it to the exporting processor.
 */
export class RedactingSpanProcessor {
  /**
   * @param {import('@opentelemetry/sdk-trace').SpanProcessor} next
   * @param {() => {includeOptInAttributes?: boolean}} [getOptions] - Read per span, so admin changes apply
   */
  constructor(next, getOptions = () => ({})) {
    this.next = next;
    this.getOptions = getOptions;
  }

  onStart(span, parentContext) {
    this.next.onStart(span, parentContext);
  }

  onEnd(span) {
    let options;
    try {
      options = this.getOptions();
      // spans.enabled is switched off at runtime: the helpers stop creating
      // spans, and this drops the ones auto-instrumentation still creates.
      if (options.exportEnabled === false) return;
      redactSpan(span, options);
    } catch {
      // A span that could not be redacted is dropped, never exported as it is.
      return;
    }
    this.next.onEnd(span);
  }

  forceFlush() {
    return this.next.forceFlush();
  }

  shutdown() {
    return this.next.shutdown();
  }
}
