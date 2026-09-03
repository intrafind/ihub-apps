import { z } from 'zod';
import { SAFE_ID_PATTERN } from '../utils/pathSecurity.js';
import { VOCABULARY_MAX_TERMS, VOCABULARY_MAX_TERM_LENGTH } from '../../shared/speechVocabulary.js';

export const zSafeId = z
  .string()
  .regex(
    SAFE_ID_PATTERN,
    'ID must contain only alphanumeric characters, underscores, dots, and hyphens'
  );

/**
 * Custom vocabulary ("hotwords") for speech-to-text.
 *
 * Reused by the platform (`speech.realtime.vocabulary`), model
 * (`<transcription model>.vocabulary`) and app (`transcription.vocabulary`)
 * schemas — the three layers `shared/speechVocabulary.js` merges.
 *
 * `enabled` is optional and treated as TRUE when omitted (see
 * `normalizeVocabulary`), so a hand-written block that only lists terms works.
 * There is no per-term weight: vLLM's `hotwords` is a plain term string with no
 * score, and a knob that maps to nothing upstream is worse than no knob.
 */
export const speechVocabularySchema = z
  .object({
    enabled: z.boolean().optional(),
    terms: z
      .array(z.string().trim().min(1).max(VOCABULARY_MAX_TERM_LENGTH))
      .max(VOCABULARY_MAX_TERMS, `At most ${VOCABULARY_MAX_TERMS} vocabulary terms are supported`)
      .optional()
  })
  .strict();
