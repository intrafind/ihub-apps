// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The iFinder OCR service as an OCR engine (`com.intrafind/ifinder-ocr`,
 * `type: "ocr"`, installed as `ifinder-ocr`).
 *
 * The service (`if-ocr`, a Spring Boot service running Tesseract, default port
 * 9618) has one synchronous endpoint, `POST {serviceUrl}/v1/text`: the raw file
 * as `application/octet-stream`, the media type in the `contenttype` query
 * parameter, the recognized text back as `text/plain`. It reads PDFs as well,
 * but iHub only ever sends it images: a PDF page goes as a PNG, and only a
 * page without a text layer (`services/ocr/textRecognition.js`). Images it
 * reads: PNG, JPEG, GIF, BMP, TIFF (Java ImageIO); not WebP.
 *
 * In its default setup the service accepts every request (pre-auth header
 * mode). An installation configured for JWT or OAuth2 gets the optional
 * credential as `Authorization: Bearer <secret>`.
 *
 * The address is the admin's, so it goes through the SSRF guard with private
 * addresses allowed (an on-prem service), the connection is pinned to the
 * checked address, redirects are not followed, and `httpFetch` applies the
 * proxy and `ssl.domainWhitelist`.
 *
 * @module services/integrations/protocols/native/connectors/ifinderOcr
 */
import credentialService from '../../../../../CredentialService.js';
import { httpFetch, isSsrfTrustedHost } from '../../../../../../utils/httpConfig.js';
import { assertPublicTarget, createPinnedLookup } from '../../../../../../utils/ssrfGuard.js';
import logger from '../../../../../../utils/logger.js';

const COMPONENT = 'IFinderOcr';

/** The service's API path when the URL names none. */
export const DEFAULT_API_PATH = '/ocr-api';

/** How long one image may take when the installation sets nothing. */
export const DEFAULT_TIMEOUT_MS = 120000;

/** The image types the service reads (Java ImageIO without plugins). */
export const IFINDER_OCR_IMAGE_TYPES = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/bmp',
  'image/tiff'
]);

/** Most characters of an error body kept in a message. */
const MAX_ERROR_DETAIL = 300;

/**
 * The service's API base URL from what the admin entered: http(s), no
 * credentials in it, no trailing slash; a URL without a path gets
 * `/ocr-api`, a trailing `/v1/text` is removed.
 *
 * @param {*} raw
 * @returns {string|null}
 * @example
 * normalizeServiceUrl('http://if-ocr:9618');                   // 'http://if-ocr:9618/ocr-api'
 * normalizeServiceUrl('http://if-ocr:9618/ocr-api/v1/text/');  // 'http://if-ocr:9618/ocr-api'
 */
export function normalizeServiceUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  let path = url.pathname.replace(/\/+$/, '').replace(/\/v1\/text$/i, '');
  if (!path) path = DEFAULT_API_PATH;
  return `${url.origin}${path}`;
}

/** The `Authorization` header value of a secret: as it is with a scheme, else a Bearer token. */
export function authorizationHeaderOf(secret) {
  const value = String(secret).trim();
  return /^(basic|bearer)\s+\S/i.test(value) ? value : `Bearer ${value}`;
}

/**
 * What a call needs, from the installation's values.
 *
 * @param {Object} values - `serviceUrl`, `authorizationRef`, `timeoutMs`
 * @returns {{baseUrl: string|null, authorization: string|undefined, ref: string|null, refMissing: boolean, timeoutMs: number}}
 */
export function resolveIfinderOcrSettings(values = {}) {
  const baseUrl = normalizeServiceUrl(values?.serviceUrl);
  const timeout = Number(values?.timeoutMs);
  const timeoutMs =
    Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : DEFAULT_TIMEOUT_MS;
  const ref = values?.authorizationRef;
  if (typeof ref !== 'string' || !ref) {
    return { baseUrl, authorization: undefined, ref: null, refMissing: false, timeoutMs };
  }
  try {
    const secret = credentialService.tryResolveSecret(ref);
    if (secret) {
      return {
        baseUrl,
        authorization: authorizationHeaderOf(secret),
        ref,
        refMissing: false,
        timeoutMs
      };
    }
  } catch (error) {
    logger.error('Failed to resolve the iFinder OCR credential from the credential store', {
      component: COMPONENT,
      error: error.message
    });
  }
  return { baseUrl, authorization: undefined, ref, refMissing: true, timeoutMs };
}

/**
 * The SSRF check of the service address: a host on `ssrf.allowedHosts` or
 * `ssl.domainWhitelist` passes unchecked; any other must resolve to addresses
 * the guard accepts with private ranges allowed, and the connection is pinned
 * to them.
 *
 * @param {string} baseUrl
 * @returns {Promise<{lookup?: Function}>}
 * @throws {Error} code `IFINDER_OCR_TARGET_BLOCKED`, status 400
 */
export async function checkIfinderOcrTarget(baseUrl) {
  const url = new URL(baseUrl);
  if (isSsrfTrustedHost(url.hostname)) return {};
  const verdict = await assertPublicTarget(url, { allowPrivate: true });
  if (!verdict.ok) {
    throw requestError(
      `The OCR service address ${url.hostname} is refused: ${verdict.reason}. A loopback, link-local or metadata address, or a name that does not resolve, needs the host on ssrf.allowedHosts (Admin → Security).`,
      { status: 400, code: 'IFINDER_OCR_TARGET_BLOCKED' }
    );
  }
  return { lookup: createPinnedLookup(verdict.addresses, { allowPrivate: true }) };
}

function requestError(message, { status, code } = {}) {
  const error = new Error(message);
  if (status !== undefined) error.status = status;
  if (code) error.code = code;
  return error;
}

/** The service's own words about a failed request: a problem+json `detail`/`title`, else the body. */
function errorDetailOf(body) {
  const text = String(body || '').trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(text);
    const detail = parsed?.detail || parsed?.message || parsed?.title || parsed?.error;
    if (typeof detail === 'string' && detail) return detail.slice(0, MAX_ERROR_DETAIL);
  } catch {
    // Not JSON: the text as it is.
  }
  return text.slice(0, MAX_ERROR_DETAIL);
}

/**
 * Create the connector. The transport and the SSRF check are injected by tests.
 *
 * @param {Object} [deps]
 * @param {(url: string, options: Object) => Promise<Object>} [deps.fetchImpl] - defaults to `httpFetch`
 * @param {(baseUrl: string) => Promise<{lookup?: Function}>} [deps.targetGuard]
 * @param {(values: Object) => Object} [deps.settingsResolver]
 * @returns {Object} the native connector
 */
export function createIfinderOcrConnector({
  fetchImpl = httpFetch,
  targetGuard = checkIfinderOcrTarget,
  settingsResolver = resolveIfinderOcrSettings
} = {}) {
  /**
   * Send one image to the service.
   *
   * @param {Object} settings - {@link resolveIfinderOcrSettings}
   * @param {Buffer} bytes
   * @param {string} mimeType
   * @returns {Promise<string>} the recognized text
   * @throws {Error} with `status` for an answer of the service (4xx stops the document)
   */
  async function recognize(settings, bytes, mimeType) {
    if (!settings.baseUrl) {
      throw requestError('The iFinder OCR service has no valid service URL', { status: 400 });
    }
    if (!IFINDER_OCR_IMAGE_TYPES.includes(mimeType)) {
      throw requestError(`The iFinder OCR service does not read images of type ${mimeType}`, {
        status: 415
      });
    }
    const { lookup } = await targetGuard(settings.baseUrl);
    const url = `${settings.baseUrl}/v1/text?contenttype=${encodeURIComponent(mimeType)}`;
    const headers = {
      'Content-Type': 'application/octet-stream',
      Accept: 'text/plain, application/problem+json, application/json'
    };
    if (settings.authorization) headers.Authorization = settings.authorization;
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: bytes,
      redirect: 'manual',
      signal: AbortSignal.timeout(settings.timeoutMs),
      ...(lookup ? { lookup } : {})
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers?.get?.('location');
      throw requestError(
        `The iFinder OCR service answered a redirect (HTTP ${response.status}${
          location ? ` to ${location}` : ''
        }); use the address it leads to as the service URL`
      );
    }
    if (!response.ok) {
      const detail = errorDetailOf(await response.text().catch(() => ''));
      throw requestError(
        `The iFinder OCR service answered HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
        { status: response.status }
      );
    }
    return String(await response.text()).trim();
  }

  return {
    id: 'ifinderOcr',
    actions: {
      recognize: {
        /**
         * The OCR engine contract: `{ content (base64), mimeType, name? }` in,
         * `{ text }` out.
         */
        async run(args = {}, ctx = {}) {
          const content = typeof args.content === 'string' ? args.content : '';
          if (!content) throw requestError('No image to recognize', { status: 400 });
          const mimeType = String(args.mimeType || '')
            .split(';')[0]
            .trim()
            .toLowerCase();
          const settings = settingsResolver(ctx.values || {});
          const text = await recognize(settings, Buffer.from(content, 'base64'), mimeType);
          return { text };
        }
      }
    },

    /**
     * The installation test, against the values as entered: the address and
     * the credential, then one recognition of a small blank image.
     */
    async test({ values } = {}) {
      const settings = settingsResolver(values || {});
      const step = settingsStep(settings);
      if (step.status === 'fail') return [step];
      return [step, await recognitionStep(settings)];
    },

    /** Nothing is cached here; the settings are read on every call. */
    invalidate() {}
  };

  async function recognitionStep(settings) {
    const label = 'Recognize a test image';
    const started = Date.now();
    try {
      const text = await recognize(settings, blankTestImage(), 'image/png');
      return {
        id: 'recognize',
        label,
        status: 'ok',
        message: `The service answered in ${Date.now() - started} ms${
          text ? '' : ' (no text on the blank test image, as expected)'
        }`
      };
    } catch (error) {
      return {
        id: 'recognize',
        label,
        status: 'fail',
        message: error.message,
        hints: hintsFor(error)
      };
    }
  }
}

/** The address and credential step of the test. */
function settingsStep(settings) {
  const label = 'Service';
  if (!settings.baseUrl) {
    return {
      id: 'service',
      label,
      status: 'fail',
      message: 'No service URL, or it is not an http(s) URL without credentials',
      hints: ['Enter the address of the OCR service, e.g. http://if-ocr:9618/ocr-api']
    };
  }
  if (settings.refMissing) {
    return {
      id: 'service',
      label,
      status: 'warn',
      message: `${settings.baseUrl}; credential "${settings.ref}" has no value or does not exist, so no Authorization header is sent`,
      hints: [
        'Pick a credential that holds the secret, or clear the field if the service needs none'
      ]
    };
  }
  if (settings.authorization && sendsCredentialInClear(settings.baseUrl)) {
    return {
      id: 'service',
      label,
      status: 'warn',
      message: `${settings.baseUrl}: the Authorization header from credential "${settings.ref}" is sent over plain http, so anyone on the network path can read it`,
      hints: ['Use an https:// service URL when the service needs a credential']
    };
  }
  return {
    id: 'service',
    label,
    status: 'ok',
    message: settings.authorization
      ? `${settings.baseUrl}, with an Authorization header from credential "${settings.ref}"`
      : `${settings.baseUrl}, without credentials`
  };
}

/** Whether a credential travels in clear text: plain http to a host that is not loopback. */
function sendsCredentialInClear(baseUrl) {
  const { protocol, hostname } = new URL(baseUrl);
  if (protocol !== 'http:') return false;
  return !(hostname === 'localhost' || hostname === '[::1]' || /^127\./.test(hostname));
}

/** What to look at for a failed test recognition. */
function hintsFor(error) {
  const status = Number(error?.status);
  if (error?.code === 'IFINDER_OCR_TARGET_BLOCKED') {
    return ['Add the host to ssrf.allowedHosts (Admin → Security) if it is your OCR service'];
  }
  if (status === 404) {
    return [
      'Check the API path: the service answers under /ocr-api by default (openapi.ocr.base-path)'
    ];
  }
  if (status === 401 || status === 403) {
    return ['The service asks for a sign-in: pick the credential it expects'];
  }
  if (status >= 500) {
    return [
      'Check the log of the OCR service: a missing license for service.ocr or a wrong Tesseract data path (intrafind.ocr.engine.tesseract.data-path) fails every request'
    ];
  }
  if (!status) {
    return [
      'Check that the service runs and that iHub reaches its host and port (9618 by default)',
      'A service with a certificate from a private CA needs its host on ssl.domainWhitelist'
    ];
  }
  return [];
}

/**
 * A small white PNG (64 × 32): enough for the service to run a recognition,
 * with no text on it. A constant, so this module needs no image library.
 */
const BLANK_TEST_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAYAAACinX6EAAAAR0lEQVR4AeXBAQEAAAiAIPP/5+qHMPsIkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJkziJk7gDIWYEPMz9We4AAAAASUVORK5CYII=';

function blankTestImage() {
  return Buffer.from(BLANK_TEST_PNG_BASE64, 'base64');
}

export default createIfinderOcrConnector();
