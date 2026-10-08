/**
 * Rules of the EU AI Act Detection tab, kept out of the component:
 * verdict tones, the signed-report download, hash shortening, and
 * validation for the expert, key-group and key-bundle forms.
 *
 * Contract: `POST /api/provenance/verify` and the `/admin/ai-transparency/
 * detection|key-groups|benchmark` endpoints (concept §8.4).
 *
 * @module features/admin/components/euAiAct/detectionModel
 */

/** Minimum justification length the server enforces for expert approvals. */
export const MIN_REASON_LENGTH = 10;

/** Minimum passphrase length for encrypted key bundles. */
export const MIN_PASSPHRASE_LENGTH = 12;

/** Allowed key-group ids (server: `/^[a-z0-9._-]{1,64}$/`). */
export const KEY_GROUP_ID_PATTERN = /^[a-z0-9._-]{1,64}$/;

/** Allowed context width of the vLLM watermark (server: 1–64). */
export const CONTEXT_WIDTH_RANGE = Object.freeze({ min: 1, max: 64 });

/** Number of entries the detection log view requests. */
export const DETECTION_LOG_LIMIT = 100;

/**
 * Tone of a detection verdict for icon/colour (the text is always shown too).
 *
 * @param {'ai-generated'|'not-detected'|'inconclusive'|string} verdict
 * @returns {'warning'|'success'|'neutral'|'info'}
 */
export function verdictTone(verdict) {
  if (verdict === 'ai-generated') return 'info';
  if (verdict === 'not-detected') return 'neutral';
  if (verdict === 'inconclusive') return 'warning';
  return 'neutral';
}

/**
 * Tone of a benchmark row status.
 * @param {'pass'|'fail'|'skipped'|string} status
 * @returns {'success'|'error'|'neutral'}
 */
export function benchmarkStatusTone(status) {
  if (status === 'pass') return 'success';
  if (status === 'fail') return 'error';
  return 'neutral';
}

/**
 * Shorten a content hash for tables: `sha256:1a2b3c4d…9f8e7d6c`.
 *
 * @param {string} hash - e.g. `sha256:<64 hex>`
 * @param {number} [keep=8] - Hex characters kept at each end
 * @returns {string}
 */
export function shortenHash(hash, keep = 8) {
  if (!hash || typeof hash !== 'string') return '—';
  const colon = hash.indexOf(':');
  const prefix = colon >= 0 ? hash.slice(0, colon + 1) : '';
  const hex = colon >= 0 ? hash.slice(colon + 1) : hash;
  if (hex.length <= keep * 2 + 1) return hash;
  return `${prefix}${hex.slice(0, keep)}…${hex.slice(-keep)}`;
}

/**
 * The signed detection report as a downloadable JSON document.
 *
 * `report` is the compact JWS (verifiable with `POST /api/provenance/report/verify`);
 * `reportPayload` is its decoded payload for human readers.
 *
 * @param {{ result?: Object, report?: string|null, reportPayload?: Object|null }} response
 * @returns {{ filename: string, data: Object } | null} null when there is no signed report
 */
export function buildReportDownload(response) {
  if (!response?.report) return null;
  const sha = String(response.result?.content?.sha256 || '')
    .replace(/^sha256:/, '')
    .slice(0, 12);
  const checkedAt = String(response.result?.checkedAt || new Date().toISOString())
    .replace(/\..+$/, '')
    .replace(/:/g, '-');
  return {
    filename: `ihub-detection-report-${sha || 'content'}-${checkedAt}.json`,
    data: {
      report: response.report,
      reportPayload: response.reportPayload ?? null
    }
  };
}

/**
 * Validate the "approve expert" form.
 *
 * @param {{ userId: string, reason: string }} form
 * @returns {{ userId?: 'required', reason?: 'reasonTooShort' }}
 */
export function validateExpertForm(form) {
  const errors = {};
  if (!String(form?.userId ?? '').trim()) errors.userId = 'required';
  if (String(form?.reason ?? '').trim().length < MIN_REASON_LENGTH) {
    errors.reason = 'reasonTooShort';
  }
  return errors;
}

/**
 * Body for `POST /admin/ai-transparency/detection/experts`.
 * @param {{ userId: string, name?: string, reason: string }} form
 * @returns {{ userId: string, name?: string, reason: string }}
 */
export function buildExpertBody(form) {
  const body = { userId: form.userId.trim(), reason: form.reason.trim() };
  const name = String(form.name ?? '').trim();
  if (name) body.name = name;
  return body;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validate the create/edit key-group form.
 *
 * @param {{ id?: string, detectorUrl?: string, contextWidth?: number|''|null }} form
 * @param {{ isNew: boolean }} options - `id` is only checked when creating
 * @returns {{ id?: 'required'|'idPattern', detectorUrl?: 'url', contextWidth?: 'contextWidth' }}
 */
export function validateKeyGroupForm(form, { isNew }) {
  const errors = {};
  if (isNew) {
    const id = String(form?.id ?? '').trim();
    if (!id) errors.id = 'required';
    else if (!KEY_GROUP_ID_PATTERN.test(id)) errors.id = 'idPattern';
  }
  const url = String(form?.detectorUrl ?? '').trim();
  if (url && !isHttpUrl(url)) errors.detectorUrl = 'url';
  const width = form?.contextWidth;
  if (width !== '' && width !== undefined && width !== null) {
    if (
      !Number.isInteger(width) ||
      width < CONTEXT_WIDTH_RANGE.min ||
      width > CONTEXT_WIDTH_RANGE.max
    ) {
      errors.contextWidth = 'contextWidth';
    }
  }
  return errors;
}

/**
 * Body for creating (`POST`) or editing (`PUT`) a key group. Empty optional
 * fields are left out on create; on edit an empty detector URL is sent as
 * `''` so it can be cleared.
 *
 * @param {{ id?: string, name?: string, detectorUrl?: string, contextWidth?: number|'' }} form
 * @param {{ isNew: boolean }} options
 * @returns {Object}
 */
export function buildKeyGroupBody(form, { isNew }) {
  const body = {};
  if (isNew) body.id = String(form.id ?? '').trim();
  const name = String(form.name ?? '').trim();
  const detectorUrl = String(form.detectorUrl ?? '').trim();
  if (name || !isNew) body.name = name;
  if (detectorUrl || !isNew) body.detectorUrl = detectorUrl;
  if (Number.isInteger(form.contextWidth)) body.contextWidth = form.contextWidth;
  return body;
}

/**
 * Validate the key-bundle export form.
 *
 * @param {{ ids: string[], passphrase: string, confirm: string }} form
 * @returns {{ ids?: 'noSelection', passphrase?: 'passphraseTooShort', confirm?: 'mismatch' }}
 */
export function validateExportForm(form) {
  const errors = {};
  if (!Array.isArray(form?.ids) || form.ids.length === 0) errors.ids = 'noSelection';
  if (String(form?.passphrase ?? '').length < MIN_PASSPHRASE_LENGTH) {
    errors.passphrase = 'passphraseTooShort';
  }
  if (form?.confirm !== form?.passphrase) errors.confirm = 'mismatch';
  return errors;
}

/**
 * Parse an uploaded key bundle. Only checks that it is a JSON object; the
 * server verifies format, version and passphrase.
 *
 * @param {string} text - File content
 * @returns {Object} Parsed bundle
 * @throws {Error} with `code: 'invalidJson'` when the file is not a JSON object
 */
export function parseKeyBundle(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const error = new Error('The file is not valid JSON');
    error.code = 'invalidJson';
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const error = new Error('The file is not a key bundle');
    error.code = 'invalidJson';
    throw error;
  }
  return parsed;
}

/**
 * File name for an exported key bundle.
 * @param {string[]} ids
 * @param {Date} [date=new Date()]
 * @returns {string} e.g. `ihub-key-bundle-customer-a-2026-09-29.json`
 */
export function keyBundleFileName(ids, date = new Date()) {
  const label = ids.length === 1 ? ids[0] : `${ids.length}-groups`;
  const safe = String(label).replace(/[^a-zA-Z0-9._-]/g, '_');
  return `ihub-key-bundle-${safe}-${date.toISOString().slice(0, 10)}.json`;
}

/**
 * The vLLM command-line argument for a key group's watermark config, quoted
 * for POSIX shells (single quotes inside the JSON are escaped).
 *
 * @param {string} watermarkConfig - JSON string from `POST /key-groups/:id/vllm-config`
 * @returns {string} e.g. `--watermark-config '{"scheme":"gumbel",…}'`
 */
export function buildVllmArgument(watermarkConfig) {
  const json = String(watermarkConfig ?? '');
  return `--watermark-config '${json.replace(/'/g, `'\\''`)}'`;
}

/**
 * Human-readable requester of a detection log entry.
 * @param {{ type?: string, id?: string }} requester
 * @returns {{ type: string, id: string }}
 */
export function describeRequester(requester) {
  return { type: requester?.type || 'anonymous', id: requester?.id || '' };
}
