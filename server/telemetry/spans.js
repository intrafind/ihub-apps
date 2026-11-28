// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The one way feature code creates spans.
 *
 * Every span of the server goes through {@link startSpan} or {@link withSpan},
 * so the tracer name, the attribute filter, the error rules and the privacy
 * rules of `docs/observability-guidelines.md` apply in one place:
 *
 * - attributes pass {@link filterSpanAttributes}: no `undefined`, no objects,
 *   no groups, no clear-text `user.id` unless `userIdMode` is `clear`, no
 *   error message, long strings cut;
 * - a failure sets `error.type` (see {@link errorTypeOf}) and status `ERROR`,
 *   never the error message or the stack (`spans.includeOptInAttributes` is
 *   the only exception);
 * - a user stop or client disconnect is not a failure: it sets
 *   `ihub.aborted=true` and leaves the status unset;
 * - `end()` is idempotent and always ends the span, whatever the settings say
 *   by then.
 *
 * When spans are switched off (`telemetry.spans.enabled: false`, or telemetry
 * off) the helpers hand out a non-recording span that still carries the
 * parent's trace context, so callers never branch on the setting.
 *
 * Feature code never calls `trace.getTracer()` itself.
 *
 * @module telemetry/spans
 */

import {
  context as otelContext,
  INVALID_SPAN_CONTEXT,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace
} from '@opentelemetry/api';
import { getUserIdMode } from './identity.js';

export { SpanKind };

const TRACER_NAME = 'ihub-apps';

/** Longest string attribute kept, except the opt-in content attributes. */
const MAX_ATTRIBUTE_LENGTH = 1024;

/** Longest content attribute (prompt / completion capture), the hard cap of #4008. */
export const MAX_CONTENT_ATTRIBUTE_LENGTH = 4096;

/** Attributes that carry captured content; only the content capture sets them. */
const CONTENT_ATTRIBUTES = new Set([
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.system_instructions'
]);

/**
 * Attributes that never leave the server, whatever a caller passes. Identities
 * go through `identity.js`; error text and stacks only through the opt-in.
 */
const FORBIDDEN_ATTRIBUTES = new Set([
  'user.groups',
  'user.email',
  'user.name',
  'user.full_name',
  'enduser.id',
  'error.message',
  'exception.message',
  'exception.stacktrace',
  'http.request.header.authorization',
  'http.request.header.cookie',
  'http.response.header.set-cookie'
]);

let spansEnabled = false;
let includeOptInAttributes = false;

/**
 * Apply the span settings of the telemetry config. Called at startup and when
 * an admin saves the telemetry settings.
 *
 * @param {Object} [config] - The `telemetry` block of platform.json
 */
export function configureSpans(config = {}) {
  spansEnabled = config.enabled === true && config.spans?.enabled !== false;
  includeOptInAttributes = config.spans?.includeOptInAttributes === true;
}

/** @returns {boolean} Whether spans are recorded. */
export function areSpansEnabled() {
  return spansEnabled;
}

/**
 * Whether an error is a stop: the user pressed stop, the client went away, a
 * signal aborted the work. A stop is not a failure.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isAbortError(err) {
  if (!err || typeof err !== 'object') return false;
  return err.name === 'AbortError' || err.code === 'ABORTED' || err.code === 'ABORT_ERR';
}

/**
 * The `error.type` of a failure: a closed code, never the message.
 *
 * HTTP statuses map to `rate_limit_exceeded`, `authentication_error`,
 * `timeout` or `http_<status>`; a closed upper-case code (`err.code`, as
 * `LLMError` and Node set it) is used as it is; otherwise the class name.
 *
 * @param {unknown} err
 * @returns {string|undefined} undefined for a stop ({@link isAbortError}) or no error
 */
export function errorTypeOf(err) {
  if (!err) return undefined;
  if (isAbortError(err)) return undefined;
  if (typeof err !== 'object') return 'Error';
  const status = err.status ?? err.statusCode;
  if (Number.isInteger(status) && status >= 400 && status < 600) {
    if (status === 429) return 'rate_limit_exceeded';
    if (status === 401 || status === 403) return 'authentication_error';
    if (status === 408) return 'timeout';
    return `http_${status}`;
  }
  if (err.code === 'ETIMEDOUT' || err.name === 'TimeoutError') return 'timeout';
  if (typeof err.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(err.code)) return err.code;
  const name = err.name || err.constructor?.name;
  return typeof name === 'string' && /^[A-Za-z_][\w.]{0,63}$/.test(name) ? name : 'Error';
}

/**
 * The attributes a span may carry: primitives and arrays of primitives, none
 * of the forbidden keys, `user.id` only in `clear` mode, strings cut to
 * {@link MAX_ATTRIBUTE_LENGTH} (content attributes to
 * {@link MAX_CONTENT_ATTRIBUTE_LENGTH}).
 *
 * @param {Object|undefined|null} attributes
 * @returns {Object} A new object
 */
export function filterSpanAttributes(attributes) {
  const out = {};
  if (!attributes || typeof attributes !== 'object') return out;
  for (const [key, raw] of Object.entries(attributes)) {
    if (raw === undefined || raw === null) continue;
    if (FORBIDDEN_ATTRIBUTES.has(key)) continue;
    if (key === 'user.id' && getUserIdMode() !== 'clear') continue;
    const limit = CONTENT_ATTRIBUTES.has(key) ? MAX_CONTENT_ATTRIBUTE_LENGTH : MAX_ATTRIBUTE_LENGTH;
    const value = sanitizeValue(raw, limit);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function sanitizeValue(value, limit) {
  switch (typeof value) {
    case 'string':
      return value.length > limit ? value.slice(0, limit) : value;
    case 'number':
      return Number.isFinite(value) ? value : undefined;
    case 'boolean':
      return value;
    default:
      if (Array.isArray(value)) {
        const items = value
          .map(item => (typeof item === 'object' ? undefined : sanitizeValue(item, limit)))
          .filter(item => item !== undefined);
        return items.length > 0 ? items : undefined;
      }
      return undefined;
  }
}

/**
 * A span as feature code sees it. All methods are safe to call after the span
 * ended and never throw.
 */
export class SpanHandle {
  /**
   * @param {import('@opentelemetry/api').Span} span
   * @param {import('@opentelemetry/api').Context} parentContext
   */
  constructor(span, parentContext) {
    this.span = span;
    this.context = trace.setSpan(parentContext, span);
    this.ended = false;
  }

  /** Whether the span is recorded (spans on and the span sampled in). */
  get isRecording() {
    return !this.ended && this.span.isRecording();
  }

  /** @returns {{traceId: string, spanId: string}} The span's ids. */
  get spanContext() {
    return this.span.spanContext();
  }

  /** Add attributes, through the filter. */
  setAttributes(attributes) {
    if (this.ended) return this;
    try {
      this.span.setAttributes(filterSpanAttributes(attributes));
    } catch {
      /* telemetry must never break a call */
    }
    return this;
  }

  /** Add an event with filtered attributes. */
  addEvent(name, attributes) {
    if (this.ended) return this;
    try {
      this.span.addEvent(name, filterSpanAttributes(attributes));
    } catch {
      /* telemetry must never break a call */
    }
    return this;
  }

  /**
   * Mark the span as failed: `error.type` and status `ERROR`. A stop
   * ({@link isAbortError}) is recorded as {@link abort} instead.
   *
   * @param {unknown} err
   */
  fail(err) {
    if (this.ended) return this;
    const type = errorTypeOf(err);
    if (!type) return this.abort();
    try {
      this.span.setAttribute('error.type', type);
      if (includeOptInAttributes && err instanceof Error) {
        this.span.recordException(err);
        this.span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      } else {
        this.span.setStatus({ code: SpanStatusCode.ERROR });
      }
    } catch {
      /* telemetry must never break a call */
    }
    return this;
  }

  /** Mark the work as stopped by the user or the client: not an error. */
  abort() {
    if (this.ended) return this;
    try {
      this.span.setAttribute('ihub.aborted', true);
    } catch {
      /* telemetry must never break a call */
    }
    return this;
  }

  /** End the span. Idempotent. */
  end() {
    if (this.ended) return;
    this.ended = true;
    try {
      this.span.end();
    } catch {
      /* telemetry must never break a call */
    }
  }

  /**
   * Run `fn` with this span active, so spans started inside become children.
   *
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  run(fn) {
    return otelContext.with(this.context, fn);
  }

  /**
   * Bind a function (a callback, an async generator function) to this span's
   * context.
   *
   * @template {Function} F
   * @param {F} fn
   * @returns {F}
   */
  bind(fn) {
    return otelContext.bind(this.context, fn);
  }

  /**
   * An async iterable whose every step runs in this span's context. An async
   * generator body runs in the context of whoever calls `next()` (the SSE
   * writer, a route), so without this the spans started inside a streamed
   * turn would attach to the caller instead of this span.
   *
   * @template T
   * @param {AsyncIterable<T>} iterable
   * @returns {AsyncIterableIterator<T>}
   */
  bindIterable(iterable) {
    const ctx = this.context;
    const iterator = iterable[Symbol.asyncIterator]();
    const step = method => arg =>
      typeof iterator[method] === 'function'
        ? otelContext.with(ctx, () => iterator[method](arg))
        : Promise.resolve({ done: true, value: arg });
    return {
      next: step('next'),
      return: step('return'),
      throw: arg =>
        typeof iterator.throw === 'function'
          ? otelContext.with(ctx, () => iterator.throw(arg))
          : Promise.reject(arg),
      [Symbol.asyncIterator]() {
        return this;
      }
    };
  }
}

/**
 * Start a span. The caller ends it (`handle.end()` in `finally`). Use
 * {@link withSpan} when the work is one async function.
 *
 * @param {string} name - Low-cardinality: operation plus at most one bounded name
 * @param {Object} [options]
 * @param {import('@opentelemetry/api').SpanKind} [options.kind=SpanKind.INTERNAL]
 * @param {Object} [options.attributes] - Passed through {@link filterSpanAttributes}
 * @param {Array<import('@opentelemetry/api').Link>} [options.links]
 * @param {import('@opentelemetry/api').Context} [options.parentContext] - Defaults to the active context
 * @param {boolean} [options.root] - Start a new trace instead of a child of the active span
 * @returns {SpanHandle}
 */
export function startSpan(name, options = {}) {
  const parentContext = options.parentContext ?? otelContext.active();
  let span;
  if (spansEnabled) {
    try {
      span = trace.getTracer(TRACER_NAME).startSpan(
        name,
        {
          kind: options.kind ?? SpanKind.INTERNAL,
          attributes: filterSpanAttributes(options.attributes),
          links: options.links,
          root: options.root === true
        },
        parentContext
      );
    } catch {
      span = undefined;
    }
  }
  if (!span) {
    // Keep the parent's trace context so nested work and outbound calls still
    // propagate it; record nothing.
    span = trace.wrapSpanContext(
      (options.root ? undefined : trace.getSpanContext(parentContext)) ?? INVALID_SPAN_CONTEXT
    );
  }
  return new SpanHandle(span, parentContext);
}

/**
 * Run `fn` inside a new active span. The span ends when `fn` settles; a thrown
 * error fails it ({@link SpanHandle#fail}) and is rethrown.
 *
 * @template T
 * @param {string} name
 * @param {Object} options - As for {@link startSpan}
 * @param {(span: SpanHandle) => Promise<T>|T} fn
 * @returns {Promise<T>}
 */
export async function withSpan(name, options, fn) {
  const handle = startSpan(name, options);
  try {
    return await handle.run(() => fn(handle));
  } catch (err) {
    handle.fail(err);
    throw err;
  } finally {
    handle.end();
  }
}

/**
 * The trace and span id of the active span, for log lines. Empty when there is
 * no valid active span.
 *
 * @returns {{trace_id?: string, span_id?: string}}
 */
export function activeTraceIds() {
  const spanContext = trace.getSpanContext(otelContext.active());
  if (!spanContext || !trace.isSpanContextValid(spanContext)) return {};
  return { trace_id: spanContext.traceId, span_id: spanContext.spanId };
}

/**
 * The active trace context as a plain object (`traceparent`, `tracestate`) to
 * send along with work handed to a worker thread, another cluster process or a
 * later run. Empty when there is no active trace.
 *
 * @param {import('@opentelemetry/api').Context} [ctx] - Defaults to the active context
 * @returns {Object<string, string>}
 */
export function injectContext(ctx = otelContext.active()) {
  const carrier = {};
  try {
    propagation.inject(ctx, carrier);
  } catch {
    /* no propagator: nothing to carry */
  }
  return carrier;
}

/**
 * The context a carrier from {@link injectContext} stands for, to start the
 * receiving side's span under (`startSpan(name, { parentContext })`).
 *
 * @param {Object<string, string>|undefined|null} carrier
 * @returns {import('@opentelemetry/api').Context}
 */
export function extractContext(carrier) {
  if (!carrier || typeof carrier !== 'object') return ROOT_CONTEXT;
  try {
    return propagation.extract(ROOT_CONTEXT, carrier);
  } catch {
    return ROOT_CONTEXT;
  }
}

/**
 * A span link to the trace a carrier came from. A run that resumes hours later
 * (a workflow after a human decision) starts a new trace that links to the
 * old one instead of a parent that ended long ago.
 *
 * @param {Object<string, string>|undefined|null} carrier
 * @returns {Array<import('@opentelemetry/api').Link>} One link, or none
 */
export function linksFrom(carrier) {
  const spanContext = trace.getSpanContext(extractContext(carrier));
  return spanContext && trace.isSpanContextValid(spanContext) ? [{ context: spanContext }] : [];
}

/** Reset the module state (tests only). */
export function resetSpansForTests() {
  spansEnabled = false;
  includeOptInAttributes = false;
}
