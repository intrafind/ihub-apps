/**
 * Presentation rules for the `/verify` page (EU AI Act Art. 50(2), issue
 * #2573) — pure functions, no React, no network, so what the page says about
 * a detection result is unit-testable
 * (`tests/unit/client/verify-result.test.jsx`).
 *
 * Inputs are the public detection API's answers (`server/routes/provenance.js`):
 * `GET /api/provenance/info` and `POST /api/provenance/verify` →
 * `{ result: { verdict, techniques, content, provenance, detector, checkedAt, summary }, report, reportPayload }`.
 *
 * @module features/verify/utils/verifyResult
 */

/** i18n key suffix per technique id (`verify.techniques.<key>`). */
const TECHNIQUE_KEYS = {
  c2pa: 'c2pa',
  'ihub-manifest': 'ihubManifest',
  trustmark: 'trustmark',
  xmp: 'xmp',
  'text-signpost': 'textSignpost',
  'text-watermark': 'textWatermark',
  'provenance-record': 'provenanceRecord'
};

/** i18n key suffix per verdict (`verify.result.verdict.<key>`). */
const VERDICT_KEYS = {
  'ai-generated': 'aiGenerated',
  'not-detected': 'notDetected',
  inconclusive: 'inconclusive'
};

/**
 * Which state the page is in, from `GET /api/provenance/info`.
 *
 * @param {Object|null} info - The info answer, or null while loading
 * @returns {'loading'|'disabled'|'signin'|'forbidden'|'ready'}
 */
export function getVerifyAvailability(info) {
  if (!info) return 'loading';
  if (info.enabled !== true || info.reason === 'disabled') return 'disabled';
  if (info.canVerify === true) return 'ready';
  if (info.reason === 'authentication-required') return 'signin';
  return 'forbidden';
}

/**
 * How the verdict is shown: tone (colours), icon and translation key.
 *
 * @param {string} verdict - `ai-generated` | `not-detected` | `inconclusive`
 * @returns {{tone: 'ai'|'none'|'inconclusive', icon: string, key: string}}
 */
export function describeVerdict(verdict) {
  const key = VERDICT_KEYS[verdict] || VERDICT_KEYS.inconclusive;
  if (key === 'aiGenerated') return { tone: 'ai', icon: 'sparkles', key };
  if (key === 'notDetected') return { tone: 'none', icon: 'information-circle', key };
  return { tone: 'inconclusive', icon: 'question-mark-circle', key };
}

/**
 * The i18n key suffix for a technique id, or null for one this client does
 * not know (the page then shows the server's English label).
 *
 * @param {string} technique
 * @returns {string|null}
 */
export function getTechniqueKey(technique) {
  return TECHNIQUE_KEYS[technique] || null;
}

/**
 * The result of one technique: `skipped` (not checked, e.g. text watermark
 * detection without expert access), `invalid` (a mark is present but its
 * signature or binding does not verify), `found`, or `none`.
 *
 * @param {Object} technique - `{ found, valid, skipped? }`
 * @returns {'found'|'none'|'skipped'|'invalid'}
 */
export function getTechniqueStatus(technique) {
  if (!technique) return 'none';
  if (technique.skipped) return 'skipped';
  if (technique.found && technique.valid === false) return 'invalid';
  if (technique.found) return 'found';
  return 'none';
}

/**
 * Whether the signature behind a technique chains to a trusted anchor.
 * `notApplicable` when nothing was found or the technique has no signer.
 *
 * @param {Object} technique - `{ found, trusted }`
 * @returns {'trusted'|'untrusted'|'notApplicable'}
 */
export function getTechniqueTrust(technique) {
  if (!technique?.found || technique.trusted === null || technique.trusted === undefined) {
    return 'notApplicable';
  }
  return technique.trusted ? 'trusted' : 'untrusted';
}

/**
 * The techniques that found a valid mark — the page names them explicitly.
 *
 * @param {Object[]} techniques
 * @returns {Object[]}
 */
export function getFindingTechniques(techniques) {
  return (Array.isArray(techniques) ? techniques : []).filter(
    technique => getTechniqueStatus(technique) === 'found'
  );
}

/**
 * Human-readable byte size.
 *
 * @param {number} bytes
 * @returns {string} e.g. `1.4 MB`, or '' for an invalid value
 */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Why a picked file cannot be submitted, or null when it can.
 *
 * @param {File|null} file
 * @param {number} [maxUploadMB] - From `GET /api/provenance/info`
 * @returns {null|'empty'|'tooLarge'}
 */
export function validateUpload(file, maxUploadMB) {
  if (!file) return 'empty';
  if (file.size === 0) return 'empty';
  const limit = Number(maxUploadMB);
  if (Number.isFinite(limit) && limit > 0 && file.size > limit * 1024 * 1024) return 'tooLarge';
  return null;
}

const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * The signed report (compact JWS) in whatever the user pasted or uploaded:
 * the downloaded report file (`{ report, reportPayload, result }`), a bare
 * API answer, a JSON string, or the token itself.
 *
 * @param {string} input
 * @returns {string|null} The token, or null when the input holds none
 * @example
 * extractSignedReport('{"report":"a.b.c","result":{}}'); // → 'a.b.c'
 */
export function extractSignedReport(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (COMPACT_JWS.test(trimmed)) return trimmed;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === 'string' && COMPACT_JWS.test(parsed.trim())) return parsed.trim();
    if (parsed && typeof parsed.report === 'string' && COMPACT_JWS.test(parsed.report.trim())) {
      return parsed.report.trim();
    }
  } catch {
    // Not JSON and not a token.
  }
  return null;
}

/**
 * The file saved by "Download signed report": the signed token, the payload
 * it signs and the full human-readable result.
 *
 * @param {{report: (string|null), reportPayload: Object, result: Object}} outcome
 * @returns {string} Pretty-printed JSON
 */
export function buildReportFileContent(outcome) {
  return JSON.stringify(
    {
      report: outcome?.report ?? null,
      reportPayload: outcome?.reportPayload ?? null,
      result: outcome?.result ?? null
    },
    null,
    2
  );
}

/**
 * i18n key and English fallback for a failed detection request.
 *
 * @param {{status?: (number|null), message?: string}} error
 * @returns {{key: string, fallback: string, params?: Object}}
 */
export function describeVerifyError(error) {
  switch (error?.status) {
    case 401:
      return {
        key: 'verify.errors.signin',
        fallback: 'Sign in to check content on this installation.'
      };
    case 403:
      return {
        key: 'verify.errors.forbidden',
        fallback: 'You are not allowed to use the detector.'
      };
    case 404:
      return {
        key: 'verify.errors.disabled',
        fallback: 'Detection is not available on this installation.'
      };
    case 413:
      return { key: 'verify.errors.tooLarge', fallback: 'The file is too large.' };
    case 429:
      return {
        key: 'verify.errors.rateLimited',
        fallback: 'Too many checks in a short time. Please wait a moment and try again.'
      };
    default:
      if (error?.message) {
        return {
          key: 'verify.errors.failed',
          fallback: 'The content could not be checked: {{message}}',
          params: { message: error.message }
        };
      }
      return {
        key: 'verify.errors.generic',
        fallback: 'The content could not be checked. Please try again.'
      };
  }
}
