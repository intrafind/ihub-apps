import { z } from 'zod';
import { SAFE_ID_PATTERN } from '../utils/pathSecurity.js';
import {
  VOCABULARY_MAX_TERMS,
  VOCABULARY_MAX_TERM_LENGTH,
  VOCABULARY_BIAS_SCORE_MIN,
  VOCABULARY_BIAS_SCORE_MAX
} from '../../shared/speechVocabulary.js';

export const zSafeId = z
  .string()
  .regex(
    SAFE_ID_PATTERN,
    'ID must contain only alphanumeric characters, underscores, dots, and hyphens'
  );

/**
 * Custom vocabulary / context biasing for speech-to-text.
 *
 * Reused by the platform (`speech.realtime.vocabulary`), model
 * (`<transcription model>.vocabulary`) and app (`transcription.vocabulary`)
 * schemas — the three layers `shared/speechVocabulary.js` merges.
 *
 * `enabled` is optional and treated as TRUE when omitted (see
 * `normalizeVocabulary`), so a hand-written block that only lists terms works.
 * No `.default()` here: the merge needs to tell "score not set" (inherit the
 * less specific layer) apart from "score set to the default value".
 */
export const speechVocabularySchema = z
  .object({
    enabled: z.boolean().optional(),
    terms: z
      .array(z.string().trim().min(1).max(VOCABULARY_MAX_TERM_LENGTH))
      .max(VOCABULARY_MAX_TERMS, `At most ${VOCABULARY_MAX_TERMS} vocabulary terms are supported`)
      .optional(),
    biasScore: z
      .number()
      .min(VOCABULARY_BIAS_SCORE_MIN, `Bias score must be at least ${VOCABULARY_BIAS_SCORE_MIN}`)
      .max(VOCABULARY_BIAS_SCORE_MAX, `Bias score cannot exceed ${VOCABULARY_BIAS_SCORE_MAX}`)
      .optional()
  })
  .strict();
