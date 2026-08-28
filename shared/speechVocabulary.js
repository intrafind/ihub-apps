/**
 * Custom vocabulary / context biasing for speech-to-text.
 *
 * Domain jargon, product names and people's names are what a general-purpose
 * STT model gets wrong most often. Context biasing fixes that by handing the
 * decoder a list of terms to prefer: the upstream raises the likelihood of the
 * token sequences that spell those terms, so "Voxtral" stops coming back as
 * "vox tral" or "Vox Trawl".
 *
 * A vocabulary can be configured at three levels, each optional:
 *
 *   1. `platform.speech.realtime.vocabulary` — organization-wide terms that
 *      apply to every transcription session (dictation and model-based alike).
 *   2. `<transcription model>.vocabulary` — terms tied to one model.
 *   3. `<app>.transcription.vocabulary` — terms for one app's subject area.
 *
 * They are MERGED, not overridden (see `mergeVocabularies`): the term lists are
 * unioned so an app adds to the org-wide list instead of replacing it, while
 * the bias score of the most specific layer wins.
 *
 * Shared between server and client so the admin UI enforces exactly the limits
 * the server validates against.
 */

/** Hard cap on merged term count. Long lists cost upstream tokenization time. */
export const VOCABULARY_MAX_TERMS = 250;
/** Hard cap on one term's length. Biasing works on words/short phrases. */
export const VOCABULARY_MAX_TERM_LENGTH = 80;
/**
 * Bias score bounds. The score is added to the logits of the biased token
 * sequences, so it trades recall for hallucination: too high and the model
 * emits the term even when it was never spoken. 2–5 is the useful band.
 */
export const VOCABULARY_BIAS_SCORE_MIN = 0;
export const VOCABULARY_BIAS_SCORE_MAX = 10;
export const VOCABULARY_DEFAULT_BIAS_SCORE = 3;

/**
 * Parse the free-form text an admin types into a term list. Accepts one term
 * per line and/or comma-separated terms, so pasting either shape works.
 * Terms may contain spaces (multi-word phrases like "Deutsche Bahn").
 *
 * @param {string|string[]} raw
 * @returns {string[]} Trimmed, non-empty terms in input order (not deduped).
 */
export function parseVocabularyTerms(raw) {
  if (Array.isArray(raw)) {
    return raw
      .filter(term => typeof term === 'string')
      .map(term => term.trim())
      .filter(Boolean);
  }
  if (typeof raw !== 'string') return [];
  return raw
    .split(/[\n,]/)
    .map(term => term.trim())
    .filter(Boolean);
}

/** Render a term list back into the one-per-line form the admin textarea shows. */
export function formatVocabularyTerms(terms) {
  return Array.isArray(terms) ? terms.join('\n') : '';
}

/**
 * Clamp a bias score into the supported range. Non-numeric input falls back to
 * the default rather than disabling biasing, so a malformed value degrades to
 * "sensible" instead of "silently off".
 */
export function clampBiasScore(value) {
  const score = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(score)) return VOCABULARY_DEFAULT_BIAS_SCORE;
  return Math.min(VOCABULARY_BIAS_SCORE_MAX, Math.max(VOCABULARY_BIAS_SCORE_MIN, score));
}

/**
 * Normalize one configured vocabulary layer.
 *
 * `enabled` defaults to TRUE when omitted: a layer that lists terms is meant to
 * be used, and requiring a second opt-in flag is the kind of trap where
 * hand-edited config silently does nothing. `enabled: false` is the off switch.
 *
 * @param {{enabled?: boolean, terms?: string[]|string, biasScore?: number}} [vocabulary]
 * @returns {{enabled: boolean, terms: string[], biasScore: number}|null} Null
 *   when the layer contributes nothing (absent, disabled, or no usable terms).
 */
export function normalizeVocabulary(vocabulary) {
  if (!vocabulary || typeof vocabulary !== 'object') return null;
  if (vocabulary.enabled === false) return null;

  const seen = new Set();
  const terms = [];
  for (const term of parseVocabularyTerms(vocabulary.terms)) {
    // Case matters to a tokenizer ("SAP" and "Sap" are different sequences), so
    // dedupe exactly rather than case-insensitively.
    const trimmed = term.slice(0, VOCABULARY_MAX_TERM_LENGTH).trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    terms.push(trimmed);
    if (terms.length >= VOCABULARY_MAX_TERMS) break;
  }
  if (!terms.length) return null;

  return {
    enabled: true,
    terms,
    biasScore: clampBiasScore(
      vocabulary.biasScore === undefined || vocabulary.biasScore === null
        ? VOCABULARY_DEFAULT_BIAS_SCORE
        : vocabulary.biasScore
    )
  };
}

/**
 * Merge vocabulary layers from least to most specific (platform, model, app).
 *
 * Terms are UNIONED in layer order — an app's vocabulary adds to the org-wide
 * one rather than replacing it, which is what an admin who set both expects.
 * The bias score comes from the most specific layer that explicitly set one,
 * so a single app can turn the pressure up without touching the platform.
 *
 * @param {...(Object|null|undefined)} layers - Raw (unnormalized) vocabularies.
 * @returns {{enabled: boolean, terms: string[], biasScore: number}|null}
 */
export function mergeVocabularies(...layers) {
  const seen = new Set();
  const terms = [];
  let biasScore = null;

  for (const layer of layers) {
    const normalized = normalizeVocabulary(layer);
    if (!normalized) continue;
    // Only an explicit score overrides a less specific layer; a layer that just
    // lists terms inherits the score already in effect.
    if (layer.biasScore !== undefined && layer.biasScore !== null) {
      biasScore = normalized.biasScore;
    }
    for (const term of normalized.terms) {
      if (seen.has(term) || terms.length >= VOCABULARY_MAX_TERMS) continue;
      seen.add(term);
      terms.push(term);
    }
  }

  if (!terms.length) return null;
  return {
    enabled: true,
    terms,
    biasScore: biasScore === null ? VOCABULARY_DEFAULT_BIAS_SCORE : biasScore
  };
}

/**
 * Build the upstream context-biasing payload for a vLLM realtime session.
 *
 * Snake_case because it goes on the wire to vLLM, which mirrors the
 * OpenAI-compatible request shape (`context_biasing: { words, bias_score }`).
 *
 * Returns null when nothing is configured — the caller must then omit the field
 * entirely. That is deliberate: an endpoint build without context-biasing
 * support may reject an unknown session field, so deployments that configure no
 * vocabulary keep sending exactly the frames they send today.
 *
 * @param {{terms: string[], biasScore: number}|null} vocabulary - Merged result.
 * @returns {{words: string[], bias_score: number}|null}
 */
export function buildContextBiasing(vocabulary) {
  if (!vocabulary?.terms?.length) return null;
  return {
    words: vocabulary.terms,
    bias_score: clampBiasScore(vocabulary.biasScore)
  };
}

export default {
  VOCABULARY_MAX_TERMS,
  VOCABULARY_MAX_TERM_LENGTH,
  VOCABULARY_BIAS_SCORE_MIN,
  VOCABULARY_BIAS_SCORE_MAX,
  VOCABULARY_DEFAULT_BIAS_SCORE,
  parseVocabularyTerms,
  formatVocabularyTerms,
  clampBiasScore,
  normalizeVocabulary,
  mergeVocabularies,
  buildContextBiasing
};
