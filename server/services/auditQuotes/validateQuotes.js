/**
 * Quote Validation — pure helpers
 *
 * The audit story rests on every quote in the final report being verifiable
 * against the original document. Pure substring matching can't survive PDF
 * artifacts (line wraps, hyphenated word-breaks, OCR variants, unicode
 * differences) so the workflow uses a hybrid strategy:
 *
 *   1. Normalize both the quote and the source text.
 *   2. Attempt substring match — the "fast path".
 *   3. On miss, flag the quote for LLM-assisted fallback. The executor
 *      handles the LLM call so this module stays pure and testable.
 *
 * @module services/auditQuotes/validateQuotes
 */

/**
 * Normalize a string for substring matching.
 *
 *   - Unicode NFC
 *   - Collapse runs of whitespace (spaces, tabs, newlines) to one space
 *   - Dehyphenate word-break line wraps: "infor-\nmation" → "information"
 *   - Trim
 *
 * Case is preserved — case-insensitive matching would falsely validate
 * different acronyms or named entities that happen to share letters.
 *
 * @param {string} input
 * @returns {string}
 */
export function normalizeForMatching(input) {
  if (typeof input !== 'string') return '';
  return input
    .normalize('NFC')
    .replace(/(\w)-\s*\n\s*(\w)/g, '$1$2')   // dehyphenate line wraps first
    .replace(/[\s ]+/g, ' ')             // collapse whitespace (incl. nbsp)
    .trim();
}

/**
 * Run the fast-path check on a single quote against a source text.
 *
 * @param {string} quoteText
 * @param {string} sourceText
 * @returns {{ matched: boolean, normalizedQuote: string, normalizedSource: string }}
 */
export function fastPathMatch(quoteText, sourceText) {
  const normalizedQuote = normalizeForMatching(quoteText);
  const normalizedSource = normalizeForMatching(sourceText);
  if (!normalizedQuote) return { matched: false, normalizedQuote, normalizedSource };
  return {
    matched: normalizedSource.includes(normalizedQuote),
    normalizedQuote,
    normalizedSource
  };
}

/**
 * Plan validation for an Evidence record's quotes against a source text.
 *
 * Returns per-quote outcomes. Quotes that hit the fast path are marked
 * `validated: true` immediately. Quotes that miss carry `needsLlm: true`
 * so the executor knows to call the LLM fallback.
 *
 * This function is pure — no I/O, no LLM. It's the synchronous decision
 * layer the QuoteValidatorNodeExecutor wraps with LLM calls and state writes.
 *
 * @param {Object} args
 * @param {Array<{text: string}>} args.quotes
 * @param {string} args.sourceText
 * @returns {Array<{
 *   index: number,
 *   text: string,
 *   validated: boolean,
 *   needsLlm: boolean,
 *   normalizedQuote: string
 * }>}
 */
export function planQuoteValidation({ quotes, sourceText }) {
  if (!Array.isArray(quotes) || quotes.length === 0) return [];
  const normalizedSource = normalizeForMatching(sourceText || '');

  return quotes.map((q, index) => {
    const text = typeof q === 'string' ? q : String(q?.text ?? '');
    const normalizedQuote = normalizeForMatching(text);
    if (!normalizedQuote) {
      return {
        index,
        text,
        validated: false,
        needsLlm: false,
        normalizedQuote
      };
    }
    const matched = normalizedSource.includes(normalizedQuote);
    return {
      index,
      text,
      validated: matched,
      needsLlm: !matched,
      normalizedQuote
    };
  });
}

/**
 * Build the LLM verdict prompt for a single quote against a source window.
 *
 * The system prompt forbids paraphrase tolerance — we want substantive
 * verbatim match modulo PDF artifacts, not "captures the gist". The
 * structured JSON response shape is consumed by `parseLlmQuoteVerdict`.
 *
 * @param {Object} args
 * @param {string} args.quoteText
 * @param {string} args.sourceWindow
 * @returns {{ system: string, user: string }}
 */
export function buildLlmVerdictPrompt({ quoteText, sourceWindow }) {
  const system =
    'You verify whether a quote was actually extracted from a source text. ' +
    'Tolerate normal PDF artifacts: hyphenation across line breaks, collapsed whitespace, ' +
    'unicode equivalents. Do NOT tolerate paraphrasing — the quote must be substantively ' +
    'the same sequence of words. ' +
    'Return ONLY JSON of the form ' +
    '{"validated": <bool>, "closestMatch": "<closest matching passage from the source, or empty>", "confidence": "high"|"medium"|"low"}. ' +
    'No prose, no markdown fences.';
  const user =
    `QUOTE TO VERIFY:\n"""${quoteText}"""\n\n` +
    `SOURCE TEXT:\n"""${sourceWindow}"""`;
  return { system, user };
}

/**
 * Parse the LLM's JSON verdict.
 *
 * Tolerant of markdown fences and surrounding prose since some models add
 * them despite instruction. Returns a normalized shape; on parse failure,
 * returns a "low confidence, not validated" verdict so the quote surfaces
 * as flagged in the final report rather than silently passing.
 *
 * @param {string} llmContent
 * @returns {{ validated: boolean, closestMatch: string, confidence: 'high'|'medium'|'low' }}
 */
export function parseLlmQuoteVerdict(llmContent) {
  const fallback = { validated: false, closestMatch: '', confidence: 'low' };
  if (typeof llmContent !== 'string') return fallback;

  // Strip markdown fences if present.
  const cleaned = llmContent.replace(/```(?:json)?/gi, '').trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return fallback;

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return fallback;
  }

  const confidence = ['high', 'medium', 'low'].includes(parsed?.confidence)
    ? parsed.confidence
    : 'low';
  return {
    validated: Boolean(parsed?.validated),
    closestMatch: typeof parsed?.closestMatch === 'string' ? parsed.closestMatch : '',
    confidence
  };
}

export default {
  normalizeForMatching,
  fastPathMatch,
  planQuoteValidation,
  buildLlmVerdictPrompt,
  parseLlmQuoteVerdict
};
