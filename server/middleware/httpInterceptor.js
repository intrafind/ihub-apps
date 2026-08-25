/**
 * Inbound half of the HTTP interceptor (see utils/httpInterceptor.js).
 *
 * Records one `HttpInterceptor` line per request served, with method, URL,
 * status, duration and — when the admin opts in — headers and bodies. Runs
 * after `express.json()`/`cookieParser()` so `req.body` is already parsed, and
 * after the request context is opened so every record carries the `requestId`
 * that joins it to the outbound calls the request triggered.
 *
 * Static assets are skipped unconditionally: nobody debugs a wire log by
 * scrolling past 200 sprite requests, and the interceptor is meant to answer
 * questions about API traffic. Narrow further with
 * `logging.http.inbound.pathAllowlist` / `pathDenylist`.
 */

import {
  isInboundEnabled,
  recordInbound,
  isCapturableContentType,
  isStreamContentType,
  STREAM_BODY_MARKER
} from '../utils/httpInterceptor.js';

/**
 * Paths that are static assets rather than API traffic. Mirrors the asset
 * prefixes `middleware/setup.js` already recognises for the auth bypass, kept
 * separate because that helper also carries auth-specific semantics (SPA
 * routes, the NTLM handshake) that have nothing to do with logging.
 */
const ASSET_PATH_RE =
  /^\/(?:assets|vite|@vite|@fs|node_modules|favicon)(?:[/.]|$)|\.(?:js|mjs|cjs|css|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|eot|webmanifest)$/i;

function isAssetPath(path) {
  return ASSET_PATH_RE.test(path || '');
}

/**
 * Tee response chunks into a capped buffer.
 *
 * Content type decides whether we capture at all, and it is only known once
 * the route has set its headers — so the decision is deferred to the first
 * write. Streamed responses (`text/event-stream`) are refused and marked, not
 * silently dropped: "why is the body missing" is a question the log should
 * answer itself.
 */
function attachResponseCapture(res, limit) {
  const state = { chunks: [], bytes: 0, decided: false, capture: false, stream: false };

  const append = (chunk, encoding) => {
    if (!state.decided) {
      state.decided = true;
      const contentType = res.getHeader('content-type');
      state.stream = isStreamContentType(contentType);
      state.capture = !state.stream && isCapturableContentType(contentType);
    }
    if (!state.capture) return;
    if (limit > 0 && state.bytes >= limit) return;
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8');
    state.chunks.push(buf);
    state.bytes += buf.length;
  };

  const originalWrite = res.write;
  const originalEnd = res.end;

  res.write = function (chunk, ...rest) {
    if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') {
      try {
        append(chunk, rest[0]);
      } catch {
        /* never let capture break the response */
      }
    }
    return originalWrite.call(this, chunk, ...rest);
  };

  res.end = function (chunk, ...rest) {
    if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') {
      try {
        append(chunk, rest[0]);
      } catch {
        /* never let capture break the response */
      }
    }
    return originalEnd.call(this, chunk, ...rest);
  };

  return () => {
    if (state.stream) return STREAM_BODY_MARKER;
    if (state.chunks.length === 0) return undefined;
    // `redactBody` applies the byte cap and the truncation note; concatenating
    // here can overshoot it by at most one chunk.
    return Buffer.concat(state.chunks).toString('utf8');
  };
}

/**
 * Express middleware recording inbound requests and their responses.
 *
 * @type {import('express').RequestHandler}
 */
export function httpInterceptorMiddleware(req, res, next) {
  const settings = isInboundEnabled(req);
  if (!settings) return next();
  if (isAssetPath(req.path || req.url)) return next();

  const startedAt = process.hrtime.bigint();
  const readResponseBody = settings.inbound.includeResponseBody
    ? attachResponseCapture(res, settings.rawBodies ? 0 : settings.maxBodyBytes)
    : null;

  let recorded = false;
  const emit = aborted => {
    if (recorded) return;
    recorded = true;
    recordInbound({
      settings,
      method: req.method,
      url: req.originalUrl || req.url,
      headers: req.headers,
      body: req.body,
      status: res.statusCode,
      responseHeaders: typeof res.getHeaders === 'function' ? res.getHeaders() : undefined,
      responseBody: readResponseBody ? readResponseBody() : undefined,
      durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
      ...(aborted ? { aborted: true } : {})
    });
  };

  res.on('finish', () => emit(false));
  // A client that walks away mid-response (an abandoned SSE stream, a cancelled
  // upload) never fires 'finish'. Those requests are worth a record too.
  res.on('close', () => emit(!res.writableFinished));

  next();
}

export default httpInterceptorMiddleware;
