/**
 * Form logic of the EU AI Act Settings tab, kept out of the component so it
 * can be unit tested: immutable path updates, "which top-level sections
 * changed", the `PUT /admin/ai-transparency/settings` patch, client-side
 * validation and the list of switches that make an installation
 * non-conforming.
 *
 * Settings shape: `DEFAULT_AI_TRANSPARENCY` in `shared/aiTransparency.js`.
 * Server rules mirrored here: `server/validators/aiTransparencySchema.js`.
 *
 * @module features/admin/components/euAiAct/settingsModel
 */

/**
 * Top-level keys the settings form may send (the server's EDITABLE_SECTIONS).
 * `dismissals` and `detection.experts` are managed elsewhere and never sent.
 */
export const SETTINGS_SECTION_KEYS = Object.freeze([
  'provider',
  'editorialResponsibility',
  'termsOfService',
  'interactionDisclosure',
  'labels',
  'images',
  'text',
  'provenance',
  'exports',
  'signing',
  'detection',
  'installationUrl'
]);

/** Marker every trusted anchor must contain. */
export const PEM_CERTIFICATE_MARKER = '-----BEGIN CERTIFICATE-----';

/**
 * Switches whose "off" state makes the installation non-conforming
 * (concept §8.6). Each entry: settings path + predicate on the value.
 */
export const NON_CONFORMING_WHEN = Object.freeze({
  'interactionDisclosure.enabled': value => value === false,
  'images.c2pa': value => value === false,
  'images.watermark': value => value === 'none',
  'signing.enabled': value => value === false,
  'detection.enabled': value => value === false
});

/**
 * Deep copy of plain JSON settings.
 * @param {Object|undefined} value
 * @returns {Object|undefined}
 */
export function cloneSettings(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * Read a dot path (`'detection.rateLimit.limit'`) from an object.
 * @param {Object} obj
 * @param {string} path
 * @returns {unknown}
 */
export function getIn(obj, path) {
  return path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), obj);
}

/**
 * Return a copy of `obj` with `path` set to `value`; untouched branches keep
 * their identity so React can skip re-rendering them.
 *
 * @param {Object} obj
 * @param {string} path - Dot path; numeric segments index arrays
 * @param {unknown} value
 * @returns {Object}
 */
export function setIn(obj, path, value) {
  const [head, ...rest] = path.split('.');
  const base = obj ?? {};
  const copy = Array.isArray(base) ? [...base] : { ...base };
  copy[head] = rest.length === 0 ? value : setIn(base[head], rest.join('.'), value);
  return copy;
}

/**
 * The value of one top-level section as it would be sent to the server:
 * - `detection`: without `experts` / `zeroRetention` (read-only here);
 * - `signing.trustedAnchors`: trimmed, empty entries dropped;
 * - `installationUrl`: trimmed.
 *
 * @param {string} key - Top-level section key
 * @param {unknown} value - Section value from the draft
 * @returns {unknown}
 */
export function normalizeSection(key, value) {
  if (key === 'installationUrl') return typeof value === 'string' ? value.trim() : '';
  if (value === null || typeof value !== 'object') return value;
  if (key === 'detection') {
    const { experts: _experts, zeroRetention: _zeroRetention, ...rest } = value;
    return rest;
  }
  if (key === 'signing') {
    const anchors = Array.isArray(value.trustedAnchors) ? value.trustedAnchors : [];
    return {
      ...value,
      trustedAnchors: anchors.map(pem => String(pem ?? '').trim()).filter(Boolean)
    };
  }
  return value;
}

/**
 * Top-level sections whose normalized value differs from the loaded one.
 *
 * @param {Object} original - Settings as loaded from the server
 * @param {Object} draft - Settings as edited in the form
 * @returns {string[]} Changed keys, in form order
 */
export function getChangedSections(original, draft) {
  if (!original || !draft) return [];
  return SETTINGS_SECTION_KEYS.filter(
    key =>
      JSON.stringify(normalizeSection(key, draft[key])) !==
      JSON.stringify(normalizeSection(key, original[key]))
  );
}

/**
 * Body for `PUT /admin/ai-transparency/settings`: only changed sections,
 * each sent complete (the server deep-merges; arrays are replaced).
 *
 * @param {Object} original
 * @param {Object} draft
 * @returns {Object} e.g. `{ labels: {...}, installationUrl: 'https://…' }`
 */
export function buildSettingsPatch(original, draft) {
  const patch = {};
  for (const key of getChangedSections(original, draft)) {
    patch[key] = normalizeSection(key, draft[key]);
  }
  return patch;
}

const isInteger = value => typeof value === 'number' && Number.isInteger(value);
const isNumber = value => typeof value === 'number' && Number.isFinite(value);

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Numeric fields with their server-side limits.
 * `kind: 'integer'` requires a whole number; `max` is optional.
 */
const NUMBER_RULES = Object.freeze([
  { path: 'interactionDisclosure.reminderInterval', kind: 'integer', min: 0, max: 100 },
  { path: 'images.watermarkStrength', kind: 'number', min: 0.1, max: 1 },
  { path: 'text.watermarkMinTokens', kind: 'integer', min: 1 },
  { path: 'provenance.retentionDays', kind: 'integer', min: 0 },
  { path: 'detection.rateLimit.windowMinutes', kind: 'integer', min: 1 },
  { path: 'detection.rateLimit.limit', kind: 'integer', min: 1 },
  { path: 'detection.log.retentionDays', kind: 'integer', min: 0 }
]);

/** Technical endpoints that must be absolute http(s) URLs when set. */
const URL_PATHS = Object.freeze(['signing.tsaUrl', 'installationUrl']);

/**
 * @typedef {Object} SettingsValidationError
 * @property {string} path - Dot path of the field (`signing.trustedAnchors.2` for an anchor)
 * @property {'integerRange'|'integerMin'|'numberRange'|'url'|'pem'} code
 * @property {Object} [params] - Interpolation values (`min`, `max`)
 */

/**
 * Validate the draft before saving. Mirrors the server's Zod schema so the
 * admin sees the problem next to the field instead of a generic 400.
 *
 * @param {Object} draft
 * @returns {SettingsValidationError[]} Empty when the draft can be saved
 */
export function validateSettingsDraft(draft) {
  const errors = [];
  if (!draft) return errors;
  for (const rule of NUMBER_RULES) {
    const value = getIn(draft, rule.path);
    const valid =
      (rule.kind === 'integer' ? isInteger(value) : isNumber(value)) &&
      value >= rule.min &&
      (rule.max === undefined || value <= rule.max);
    if (!valid) {
      let code = 'integerMin';
      if (rule.kind === 'number') code = 'numberRange';
      else if (rule.max !== undefined) code = 'integerRange';
      errors.push({ path: rule.path, code, params: { min: rule.min, max: rule.max } });
    }
  }
  for (const path of URL_PATHS) {
    const value = String(getIn(draft, path) ?? '').trim();
    if (value && !isHttpUrl(value)) errors.push({ path, code: 'url' });
  }
  const anchors = getIn(draft, 'signing.trustedAnchors') || [];
  anchors.forEach((pem, index) => {
    const text = String(pem ?? '').trim();
    if (text && !text.includes(PEM_CERTIFICATE_MARKER)) {
      errors.push({ path: `signing.trustedAnchors.${index}`, code: 'pem' });
    }
  });
  return errors;
}

/**
 * Whether the setting at `path` is currently in a non-conforming state.
 *
 * @param {Object} draft
 * @param {string} path - One of the keys of NON_CONFORMING_WHEN
 * @returns {boolean}
 */
export function isNonConforming(draft, path) {
  const predicate = NON_CONFORMING_WHEN[path];
  return Boolean(predicate && draft && predicate(getIn(draft, path)));
}

/**
 * DOM id of the input for a settings path, so errors can focus the field.
 *
 * @param {string} path
 * @returns {string} e.g. `eu-settings-detection-rateLimit-limit`
 */
export function fieldIdFor(path) {
  return `eu-settings-${path.replace(/\./g, '-')}`;
}
