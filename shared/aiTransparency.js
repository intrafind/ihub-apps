/**
 * EU AI Act Art. 50 transparency — shared by the server (which marks, records
 * and reports) and the client (which shows the disclosure, badges and the
 * EU AI Act admin page).
 *
 * The concept is `concepts/2026-09-27 EU AI Act Content Marking.md`; the
 * operator documentation is `docs/eu-ai-act.md`. Everything here is plain data
 * and pure functions, so both sides agree on what the defaults are, which
 * fields are installation-specific records, and when a model counts as
 * marking its output.
 *
 * @module shared/aiTransparency
 */

/**
 * Digital source types used in C2PA actions and XMP metadata. These are
 * vocabulary identifiers that verifiers compare as exact strings, not URLs
 * that are fetched: the IPTC and C2PA specifications define them with
 * `http://`, so they must stay as written (hence NOSONAR on each).
 */
export const DIGITAL_SOURCE_TYPES = Object.freeze({
  trainedAlgorithmicMedia: 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia', // NOSONAR
  compositeWithTrainedAlgorithmicMedia:
    'http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia', // NOSONAR
  algorithmicMedia: 'http://cv.iptc.org/newscodes/digitalsourcetype/algorithmicMedia', // NOSONAR
  digitalCreation: 'http://cv.iptc.org/newscodes/digitalsourcetype/digitalCreation', // NOSONAR
  softwareImage: 'http://cv.iptc.org/newscodes/digitalsourcetype/softwareImage', // NOSONAR
  // C2PA's own term for content generated from AI training data.
  c2paTrainedAlgorithmicData: 'http://c2pa.org/digitalsourcetype/trainedAlgorithmicData' // NOSONAR
});

/** Art. 50(2) exemptions an admin may declare per app (guidelines §4.3, ¶87). */
export const EXEMPTION_TYPES = Object.freeze(['standardEditing', 'b2bTechnical']);

/** Contexts in which the guidelines (¶40) ask for periodic reminders. */
export const SENSITIVE_CATEGORIES = Object.freeze([
  'legal',
  'finance',
  'health',
  'complaints',
  'vulnerable'
]);

/**
 * Who may use the detector (`/verify`, `POST /api/provenance/verify`).
 * - `internal`: admins and approved experts only
 * - `authenticated`: every signed-in user of this installation
 * - `public`: anyone, rate-limited (e.g. for publicly shared chats)
 */
export const DETECTION_ACCESS_LEVELS = Object.freeze(['internal', 'authenticated', 'public']);

/** Text watermark schemes iHub can drive and detect. */
export const TEXT_WATERMARK_SCHEMES = Object.freeze(['vllm-gumbel']);

/** Free-form text below this many tokens is exempt from watermarking (CoP 1.1.2). */
export const DEFAULT_WATERMARK_MIN_TOKENS = 200;

/** Dismissible warning categories (concept §8.6): models and certificates only. */
export const DISMISSIBLE_WARNING_PREFIXES = Object.freeze(['model:', 'certificate:', 'app:']);

/**
 * Defaults of `platform.aiTransparency`. Compliant out of the box: every
 * switch that affects conformance starts on.
 */
export const DEFAULT_AI_TRANSPARENCY = Object.freeze({
  /** Legal entity that puts this installation into service (Art. 3(3)). */
  provider: Object.freeze({
    legalEntity: '',
    contact: '',
    address: '',
    /** `provider` or `deployer` — the operator's own role assessment. */
    role: 'provider'
  }),
  /** Art. 50(4) editorial-responsibility contact (CoP Section 2, Commitment 4). */
  editorialResponsibility: Object.freeze({ contact: '', policyUrl: '' }),
  /** Whether the terms of service prohibit removing AI markings (CoP Measure 1.2(b)). */
  termsOfService: Object.freeze({ markRemovalClause: false, url: '' }),
  /** Art. 50(1): tell people they are interacting with an AI system. */
  interactionDisclosure: Object.freeze({
    enabled: true,
    firstTurnNotice: true,
    persistentBadge: true,
    /** System-prompt guardrail: the model always admits being an AI when asked. */
    guardrail: true,
    /** Sensitive apps: remind every N assistant answers (0 disables). */
    reminderInterval: 5
  }),
  labels: Object.freeze({
    /** "AI generated" chip on every assistant message. */
    messageBadge: true,
    /** EU icon on exports: `off`, `optional` (user picks) or `always`. */
    euIcon: 'optional',
    /** Visible AI label in the header/colophon of exports. */
    exportLabel: true,
    /** Visible AI label on content agents send to people (Jira, Outlook, webhooks, shares). */
    outbound: true
  }),
  images: Object.freeze({
    /** Signed C2PA manifest on every generated image. */
    c2pa: true,
    /** Invisible watermark: `trustmark` or `none`. */
    watermark: 'trustmark',
    /** TrustMark strength between 0 and 1. */
    watermarkStrength: 0.95,
    /** Directory holding the TrustMark ONNX models (empty: `contents/data/trustmark-models`). */
    trustmarkModelPath: '',
    /** IPTC/XMP DigitalSourceType fallback for tools that don't read C2PA. */
    xmp: true
  }),
  text: Object.freeze({
    watermarkMinTokens: DEFAULT_WATERMARK_MIN_TOKENS,
    /** C2PA text manifest (Unicode variation selectors) as the CoP 3.4 signpost. */
    signpost: Object.freeze({ exports: true, clipboard: false }),
    /**
     * Open decision (concept §10.2 #3): block unmarked free-form text over the
     * token threshold instead of only flagging it. Off by default.
     */
    strictMode: false
  }),
  /** Per-message provenance records (content hash, model, time — never content). */
  provenance: Object.freeze({ enabled: true, retentionDays: 365 }),
  exports: Object.freeze({ sign: true }),
  signing: Object.freeze({
    enabled: true,
    /** Optional RFC 3161 time-stamp authority; empty uses the local clock. */
    tsaUrl: '',
    /** Extra trust anchors (PEM) — other installations of the same customer. */
    trustedAnchors: Object.freeze([]),
    /** Subject of the auto-generated certificate; empty uses the provider details. */
    organization: '',
    commonName: ''
  }),
  detection: Object.freeze({
    enabled: true,
    access: 'authenticated',
    rateLimit: Object.freeze({ windowMinutes: 15, limit: 30 }),
    /** Zero retention of submitted content (CoP 2.1.3) — not switchable off. */
    zeroRetention: true,
    /** Approved experts who may run free-form text watermark detection (CoP 2.1.2). */
    experts: Object.freeze([]),
    /** Detection log: metadata only (time, requester, hash, result). */
    log: Object.freeze({ enabled: true, retentionDays: 90 })
  }),
  /** Public base URL of this installation, used in records and the signpost. */
  installationUrl: '',
  /** Dismissed start-page warnings, each with justification and state. */
  dismissals: Object.freeze([])
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(defaults, override) {
  if (!isPlainObject(defaults)) return override === undefined ? defaults : override;
  const out = {};
  for (const [key, value] of Object.entries(defaults)) {
    const next = isPlainObject(override) ? override[key] : undefined;
    if (isPlainObject(value)) out[key] = deepMerge(value, next);
    else if (Array.isArray(value)) out[key] = Array.isArray(next) ? [...next] : [...value];
    else out[key] = next === undefined || next === null ? value : next;
  }
  if (isPlainObject(override)) {
    for (const [key, value] of Object.entries(override)) {
      if (!(key in out)) out[key] = value;
    }
  }
  return out;
}

/**
 * The effective `platform.aiTransparency`: the stored section over the
 * defaults. Arrays are replaced, never merged.
 *
 * @param {Object} [section] - `platform.aiTransparency` as stored
 * @returns {Object}
 */
export function resolveAiTransparency(section) {
  return deepMerge(DEFAULT_AI_TRANSPARENCY, isPlainObject(section) ? section : {});
}

// ── Installation-specific records ──────────────────────────────────────────

/**
 * Fields that record a decision made for ONE installation: who switched the
 * disclosure off, who declared an exemption, who acknowledged an unmarked
 * model, who dismissed a warning or approved an expert. They are removed
 * whenever configuration leaves the installation (download, backup,
 * marketplace) and dropped on import, so an importing admin has to decide
 * again (concept §8.2, §8.6).
 */
export const INSTALLATION_RECORD_PATHS = Object.freeze({
  app: Object.freeze(['aiTransparency.disclosureOptOut', 'aiTransparency.exemption']),
  model: Object.freeze(['contentMarking.acknowledgement']),
  platform: Object.freeze(['aiTransparency.dismissals', 'aiTransparency.detection.experts'])
});

function deletePath(obj, dotPath) {
  const parts = dotPath.split('.');
  let node = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isPlainObject(node?.[parts[i]])) return false;
    node = node[parts[i]];
  }
  const last = parts[parts.length - 1];
  if (!isPlainObject(node) || !(last in node)) return false;
  delete node[last];
  return true;
}

function readPath(obj, dotPath) {
  return dotPath
    .split('.')
    .reduce((node, key) => (isPlainObject(node) ? node[key] : undefined), obj);
}

/**
 * Whether a config object carries any installation-specific record.
 * @param {'app'|'model'|'platform'} kind
 * @param {Object} obj
 * @returns {boolean}
 */
export function hasInstallationRecords(kind, obj) {
  const paths = INSTALLATION_RECORD_PATHS[kind] || [];
  return paths.some(p => {
    const value = readPath(obj, p);
    return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null;
  });
}

/**
 * A copy of a config object without its installation-specific records.
 * Empty containers left behind (`aiTransparency: {}`) are removed too.
 *
 * @param {'app'|'model'|'platform'} kind
 * @param {Object} obj
 * @returns {Object} A deep copy; the input is not modified
 */
export function stripInstallationRecords(kind, obj) {
  if (!isPlainObject(obj)) return obj;
  const copy = JSON.parse(JSON.stringify(obj));
  for (const p of INSTALLATION_RECORD_PATHS[kind] || []) {
    if (!deletePath(copy, p)) continue;
    const parent = p.split('.').slice(0, -1).join('.');
    if (parent && kind !== 'platform') {
      const container = readPath(copy, parent);
      if (isPlainObject(container) && Object.keys(container).length === 0) deletePath(copy, parent);
    }
  }
  return copy;
}

// ── Model marking capability registry ──────────────────────────────────────

const UPSTREAM_RE = /^upstream:([a-z0-9._-]+)$/;

/**
 * The marking a model declares, normalised.
 *
 * `contentMarking.textWatermark` is one of:
 * - `{ scheme: 'vllm-gumbel', keyGroup }` — iHub-driven watermark in a
 *   self-hosted vLLM server
 * - `'upstream:<vendor>'` — the vendor marks the text (documented in writing)
 * - `'none'` (or unset) — not marked
 *
 * `contentMarking.imageWatermark` is `'upstream:<technique>'` (e.g.
 * `upstream:synthid` for Gemini images) or `'none'`; iHub's own image layers
 * (C2PA + TrustMark) come on top whatever the upstream does.
 *
 * @param {Object} model
 * @returns {{text: {kind: 'scheme'|'upstream'|'none'|'not-applicable', scheme?: string, keyGroup?: string, vendor?: string, perRequest?: boolean}, image: {kind: 'upstream'|'none', vendor?: string}, notes: string, acknowledgement: Object|null}}
 */
export function normalizeContentMarking(model) {
  const marking = isPlainObject(model?.contentMarking) ? model.contentMarking : {};
  const isTranscription = model?.modelType === 'transcription';
  let text;
  const tw = marking.textWatermark;
  if (isTranscription) {
    // Transcription is "standard editing" (guidelines §4.3): out of 50(2) scope.
    text = { kind: 'not-applicable' };
  } else if (isPlainObject(tw) && TEXT_WATERMARK_SCHEMES.includes(tw.scheme)) {
    text = {
      kind: 'scheme',
      scheme: tw.scheme,
      keyGroup: typeof tw.keyGroup === 'string' && tw.keyGroup ? tw.keyGroup : 'default',
      perRequest: tw.perRequest === true
    };
  } else if (typeof tw === 'string' && UPSTREAM_RE.test(tw)) {
    text = { kind: 'upstream', vendor: tw.match(UPSTREAM_RE)[1] };
  } else {
    text = { kind: 'none' };
  }
  let image = { kind: 'none' };
  if (typeof marking.imageWatermark === 'string' && UPSTREAM_RE.test(marking.imageWatermark)) {
    image = { kind: 'upstream', vendor: marking.imageWatermark.match(UPSTREAM_RE)[1] };
  }
  return {
    text,
    image,
    notes: typeof marking.notes === 'string' ? marking.notes : '',
    acknowledgement: isPlainObject(marking.acknowledgement) ? marking.acknowledgement : null
  };
}

/** Whether a model generates images (and so needs iHub's image layers). */
export function isImageModel(model) {
  return model?.supportsImageGeneration === true || isPlainObject(model?.imageGeneration);
}

/**
 * Whether a model's free-form text output is marked at all. An acknowledged
 * unmarked model is still unmarked: the acknowledgement documents the gap, it
 * does not mark the output (CoP Sub-measure 1.1.2).
 *
 * @param {Object} model
 * @returns {boolean}
 */
export function isTextMarked(model) {
  const { text } = normalizeContentMarking(model);
  return text.kind === 'scheme' || text.kind === 'upstream' || text.kind === 'not-applicable';
}

/**
 * The default `contentMarking` for a model that declares none. Cloud models
 * are unmarked unless the vendor documents marking; Gemini images carry
 * Google SynthID (concept §5.1, §5.2).
 *
 * @param {Object} model
 * @returns {Object}
 */
export function defaultContentMarking(model) {
  const marking = { textWatermark: 'none' };
  if (model?.provider === 'google' && isImageModel(model)) {
    marking.imageWatermark = 'upstream:synthid';
  }
  return marking;
}

/**
 * Whether a distortion-free watermark can embed anything at this temperature.
 * At temperature 0 (greedy decoding) the Gumbel-max scheme has no freedom, so
 * nothing is embedded (concept §5.1 "low-entropy output"). The temperature may
 * arrive as a string from a form or request body, or as `''` when unset.
 *
 * @param {number|string|null|undefined} temperature
 * @returns {boolean}
 */
export function watermarkEmbedsAtTemperature(temperature) {
  if (temperature === null || temperature === undefined || temperature === '') return true;
  const t = Number(temperature);
  return !Number.isFinite(t) || t > 0;
}

/**
 * Rough token count for the 200-token threshold, without a tokenizer:
 * ~4 characters per token for Latin text, one token per CJK character.
 *
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || !text) return 0;
  const cjk = (text.match(/[぀-ヿ㐀-鿿가-힯]/g) || []).length;
  return Math.ceil((text.length - cjk) / 4) + cjk;
}

/**
 * Whether the text-watermark duty applies to a given output.
 * @param {string} text
 * @param {Object} [aiConfig] - resolved `platform.aiTransparency`
 * @returns {boolean}
 */
export function requiresTextWatermark(text, aiConfig) {
  const min = Number(aiConfig?.text?.watermarkMinTokens) || DEFAULT_WATERMARK_MIN_TOKENS;
  return estimateTokens(text) > min;
}
