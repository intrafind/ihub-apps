/**
 * Pure helpers for the EU AI Act parts of the app and model editors and the
 * models list: installation records, the unmarked-model gate, and the
 * `contentMarking` form model. No React and no network, so all of it is
 * unit-testable (`tests/unit/client/admin-ai-transparency-editors.test.jsx`).
 *
 * Server contract: `server/routes/admin/aiTransparency.js`,
 * `server/services/provenance/records.js`; shared rules:
 * `shared/aiTransparency.js`. Concept: `concepts/2026-09-27 EU AI Act Content
 * Marking.md` §8.2.
 *
 * @module features/admin/utils/aiTransparencyAdmin
 */
import {
  isTextMarked,
  normalizeContentMarking,
  stripInstallationRecords
} from '../../../../../shared/aiTransparency.js';

/** Error code of the 409 the server answers when an unmarked model is enabled. */
export const UNMARKED_MODEL_ERROR_CODE = 'UNMARKED_MODEL_ACKNOWLEDGEMENT_REQUIRED';

/** Request body field that carries the justification for enabling an unmarked model. */
export const JUSTIFICATION_FIELD = 'aiTransparencyJustification';

/** Pattern the server accepts for a vendor / technique / key group id. */
export const MARKING_ID_PATTERN = /^[a-z0-9._-]+$/;

/**
 * The unmarked-model gate's answer, if `error` is one: the server refused to
 * enable models that do not watermark text until a justification is given.
 *
 * @param {unknown} error - Rejection of `makeAdminApiCall` (axios error)
 * @returns {{ models: string[], message: string }|null}
 */
export function getUnmarkedModelError(error) {
  const response = error?.response;
  if (response?.status !== 409 || response.data?.code !== UNMARKED_MODEL_ERROR_CODE) return null;
  return {
    models: Array.isArray(response.data.models) ? response.data.models : [],
    message: typeof response.data.error === 'string' ? response.data.error : ''
  };
}

/**
 * The JSON text of a config download, without the installation-specific
 * records (disclosure opt-out, exemption, model acknowledgement): an opt-out
 * decided for one installation must never silently carry over to another
 * (concept §8.2).
 *
 * @param {'app'|'model'} kind - What is downloaded
 * @param {Object} config - Config as the admin API returned it
 * @returns {string} Pretty-printed JSON
 */
export function serializeConfigForDownload(kind, config) {
  return JSON.stringify(stripInstallationRecords(kind, config), null, 2);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The app with its EU AI Act records replaced by the ones given — used after
 * an opt-out or exemption endpoint changed them, so the editor shows the
 * stored state without discarding the admin's unsaved edits. A `null` record
 * is removed; an `undefined` one is left as it is.
 *
 * @param {Object} app - App config in the editor
 * @param {{ disclosureOptOut?: Object|null, exemption?: Object|null }} records
 * @returns {Object} New app object (the input is not modified)
 */
export function mergeAppAiTransparencyRecords(app, records) {
  if (!isPlainObject(app)) return app;
  const block = { ...(isPlainObject(app.aiTransparency) ? app.aiTransparency : {}) };
  for (const key of ['disclosureOptOut', 'exemption']) {
    if (!(key in (records || {})) || records[key] === undefined) continue;
    if (records[key]) block[key] = records[key];
    else delete block[key];
  }
  const next = { ...app };
  if (Object.keys(block).length > 0) next.aiTransparency = block;
  else delete next.aiTransparency;
  return next;
}

/**
 * The app's `aiTransparency` block as the generic app save sends it: no
 * records (only the audited endpoints set those; the server ignores them
 * anyway), no empty localized notice entries, no empty sub-objects.
 *
 * @param {Object} app - App config in the editor
 * @returns {Object} New app object (the input is not modified)
 */
export function cleanAppAiTransparencyForSave(app) {
  if (!isPlainObject(app)) return app;
  const stripped = stripInstallationRecords('app', app);
  const block = stripped.aiTransparency;
  if (!isPlainObject(block)) return stripped;
  const next = { ...block };
  if (isPlainObject(next.firstTurnNotice)) {
    const notice = Object.fromEntries(
      Object.entries(next.firstTurnNotice).filter(
        ([, text]) => typeof text === 'string' && text.trim() !== ''
      )
    );
    if (Object.keys(notice).length > 0) next.firstTurnNotice = notice;
    else delete next.firstTurnNotice;
  }
  if (isPlainObject(next.signpost)) {
    const signpost = Object.fromEntries(
      Object.entries(next.signpost).filter(([, value]) => typeof value === 'boolean')
    );
    if (Object.keys(signpost).length > 0) next.signpost = signpost;
    else delete next.signpost;
  }
  if (next.sensitive === '' || next.sensitive === null) delete next.sensitive;
  if (next.reminderInterval === '' || next.reminderInterval === null) {
    delete next.reminderInterval;
  }
  const result = { ...stripped };
  if (Object.keys(next).length > 0) result.aiTransparency = next;
  else delete result.aiTransparency;
  return result;
}

/**
 * How the models list flags a model's text marking: `null` when it marks (or
 * is a transcription model, which is out of scope), otherwise whether the gap
 * has been acknowledged. An acknowledged model is still flagged: the
 * acknowledgement documents the gap, it does not mark anything.
 *
 * @param {Object} model - Model config
 * @returns {{ acknowledged: boolean }|null}
 */
export function getModelMarkingFlag(model) {
  if (!model || model.modelType === 'transcription') return null;
  if (isTextMarked(model)) return null;
  return { acknowledged: Boolean(normalizeContentMarking(model).acknowledgement) };
}

/**
 * The text-watermark form state of `contentMarking.textWatermark`.
 *
 * @param {*} value - Stored value: `'none'`, `'upstream:<vendor>'`, `{ scheme, keyGroup, perRequest }`
 * @returns {{ mode: 'none'|'upstream'|'vllm', vendor: string, keyGroup: string, perRequest: boolean }}
 */
export function parseTextWatermark(value) {
  const empty = { mode: 'none', vendor: '', keyGroup: '', perRequest: false };
  if (isPlainObject(value) && value.scheme === 'vllm-gumbel') {
    return {
      ...empty,
      mode: 'vllm',
      keyGroup: typeof value.keyGroup === 'string' ? value.keyGroup : '',
      perRequest: value.perRequest === true
    };
  }
  if (typeof value === 'string' && value.startsWith('upstream:')) {
    return { ...empty, mode: 'upstream', vendor: value.slice('upstream:'.length) };
  }
  return empty;
}

/**
 * `contentMarking.textWatermark` from the form state.
 *
 * @param {{ mode: string, vendor?: string, keyGroup?: string, perRequest?: boolean }} state
 * @returns {'none'|string|{ scheme: 'vllm-gumbel', keyGroup?: string, perRequest?: boolean }}
 */
export function buildTextWatermark(state) {
  if (state?.mode === 'upstream') return `upstream:${String(state.vendor || '').trim()}`;
  if (state?.mode === 'vllm') {
    const keyGroup = String(state.keyGroup || '').trim();
    return {
      scheme: 'vllm-gumbel',
      ...(keyGroup ? { keyGroup } : {}),
      ...(state.perRequest ? { perRequest: true } : {})
    };
  }
  return 'none';
}

/**
 * The image-watermark form state of `contentMarking.imageWatermark`.
 *
 * @param {*} value - `'none'` or `'upstream:<technique>'`
 * @returns {{ mode: 'none'|'upstream', technique: string }}
 */
export function parseImageWatermark(value) {
  if (typeof value === 'string' && value.startsWith('upstream:')) {
    return { mode: 'upstream', technique: value.slice('upstream:'.length) };
  }
  return { mode: 'none', technique: '' };
}

/**
 * `contentMarking.imageWatermark` from the form state.
 *
 * @param {{ mode: string, technique?: string }} state
 * @returns {string}
 */
export function buildImageWatermark(state) {
  return state?.mode === 'upstream' ? `upstream:${String(state.technique || '').trim()}` : 'none';
}

/**
 * A new `contentMarking` block with one field changed. The acknowledgement
 * record is server-managed and kept as it is; empty notes are dropped.
 *
 * @param {Object|undefined} current - `model.contentMarking`
 * @param {'textWatermark'|'imageWatermark'|'notes'} field
 * @param {*} value
 * @returns {Object}
 */
export function updateContentMarking(current, field, value) {
  const next = { ...(isPlainObject(current) ? current : {}) };
  if (!next.textWatermark) next.textWatermark = 'none';
  if (field === 'notes' && (typeof value !== 'string' || value === '')) delete next.notes;
  else next[field] = value;
  return next;
}

/**
 * Whether a record was made on another installation. Such a record is not in
 * effect here (the server ignores it: the disclosure stays on, the exemption
 * does not apply, the model is not acknowledged) until an admin here decides.
 * Unknown installation ids are treated as "this installation".
 *
 * @param {Object|null|undefined} record - Opt-out, exemption or acknowledgement record
 * @param {string|null|undefined} installationId - This installation's id
 * @returns {boolean}
 */
export function isForeignRecord(record, installationId) {
  return Boolean(
    record?.installationId && installationId && record.installationId !== installationId
  );
}
