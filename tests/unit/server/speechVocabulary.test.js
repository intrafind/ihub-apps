/**
 * Speech-to-text custom vocabulary (context biasing) — unit tests.
 *
 * Covers the pure merge/normalization rules in `shared/speechVocabulary.js` and
 * the schema changes that let a vocabulary be configured at platform, model and
 * app level. The three-layer resolution the realtime WebSocket bridge performs
 * on top of them lives in `server/tests/transcriptionModel.test.js`, which runs
 * under the server's native-ESM Jest config (configCache needs `import.meta`).
 *
 * The behavior guarded most carefully here is the opt-in one: with nothing
 * configured, NO context-biasing payload is produced, so a vLLM build that does
 * not understand the field keeps receiving exactly the session.update it always
 * did.
 */
import {
  VOCABULARY_DEFAULT_BIAS_SCORE,
  VOCABULARY_MAX_TERMS,
  VOCABULARY_MAX_TERM_LENGTH,
  buildContextBiasing,
  clampBiasScore,
  formatVocabularyTerms,
  mergeVocabularies,
  normalizeVocabulary,
  parseVocabularyTerms
} from '../../../shared/speechVocabulary.js';
import { modelConfigSchema } from '../../../server/validators/modelConfigSchema.js';
import { appConfigSchema } from '../../../server/validators/appConfigSchema.js';
import { platformConfigSchema } from '../../../server/validators/platformConfigSchema.js';

describe('parseVocabularyTerms', () => {
  test('accepts an array and trims each entry', () => {
    expect(parseVocabularyTerms([' Voxtral ', 'vLLM', ''])).toEqual(['Voxtral', 'vLLM']);
  });

  test('splits newline- and comma-separated text', () => {
    expect(parseVocabularyTerms('Voxtral\nvLLM, Kubernetes')).toEqual([
      'Voxtral',
      'vLLM',
      'Kubernetes'
    ]);
  });

  test('keeps multi-word phrases intact', () => {
    expect(parseVocabularyTerms('Deutsche Bahn\nIntraFind iHub')).toEqual([
      'Deutsche Bahn',
      'IntraFind iHub'
    ]);
  });

  test('returns an empty list for anything that is not text or an array', () => {
    expect(parseVocabularyTerms(undefined)).toEqual([]);
    expect(parseVocabularyTerms(42)).toEqual([]);
    expect(parseVocabularyTerms([1, 'ok', null])).toEqual(['ok']);
  });
});

describe('formatVocabularyTerms', () => {
  test('round-trips through the one-per-line editor form', () => {
    const terms = ['Voxtral', 'Deutsche Bahn'];
    expect(parseVocabularyTerms(formatVocabularyTerms(terms))).toEqual(terms);
  });
});

describe('clampBiasScore', () => {
  test('clamps to the supported range', () => {
    expect(clampBiasScore(-5)).toBe(0);
    expect(clampBiasScore(99)).toBe(10);
    expect(clampBiasScore(3.5)).toBe(3.5);
  });

  test('falls back to the default rather than disabling biasing', () => {
    expect(clampBiasScore('nonsense')).toBe(VOCABULARY_DEFAULT_BIAS_SCORE);
    expect(clampBiasScore(undefined)).toBe(VOCABULARY_DEFAULT_BIAS_SCORE);
  });
});

describe('normalizeVocabulary', () => {
  test('treats a block without an explicit `enabled` as enabled', () => {
    expect(normalizeVocabulary({ terms: ['Voxtral'] })).toEqual({
      enabled: true,
      terms: ['Voxtral'],
      biasScore: VOCABULARY_DEFAULT_BIAS_SCORE
    });
  });

  test('contributes nothing when explicitly disabled', () => {
    expect(normalizeVocabulary({ enabled: false, terms: ['Voxtral'] })).toBeNull();
  });

  test('contributes nothing when absent or empty', () => {
    expect(normalizeVocabulary(undefined)).toBeNull();
    expect(normalizeVocabulary({})).toBeNull();
    expect(normalizeVocabulary({ terms: ['   '] })).toBeNull();
  });

  test('dedupes exactly, preserving case (a tokenizer treats them differently)', () => {
    const result = normalizeVocabulary({ terms: ['SAP', 'SAP', 'Sap'] });
    expect(result.terms).toEqual(['SAP', 'Sap']);
  });

  test('truncates an over-long term and caps the list', () => {
    const long = 'x'.repeat(VOCABULARY_MAX_TERM_LENGTH + 20);
    expect(normalizeVocabulary({ terms: [long] }).terms[0]).toHaveLength(
      VOCABULARY_MAX_TERM_LENGTH
    );

    const many = Array.from({ length: VOCABULARY_MAX_TERMS + 50 }, (_, i) => `term-${i}`);
    expect(normalizeVocabulary({ terms: many }).terms).toHaveLength(VOCABULARY_MAX_TERMS);
  });

  test('clamps the bias score', () => {
    expect(normalizeVocabulary({ terms: ['a'], biasScore: 42 }).biasScore).toBe(10);
  });
});

describe('mergeVocabularies', () => {
  const platform = { terms: ['IntraFind', 'iHub'] };
  const model = { terms: ['Voxtral', 'iHub'], biasScore: 4 };
  const app = { terms: ['Schadensfall'] };

  test('unions terms from least to most specific, without duplicates', () => {
    expect(mergeVocabularies(platform, model, app).terms).toEqual([
      'IntraFind',
      'iHub',
      'Voxtral',
      'Schadensfall'
    ]);
  });

  test('the most specific EXPLICIT bias score wins', () => {
    expect(mergeVocabularies(platform, model, app).biasScore).toBe(4);
    expect(mergeVocabularies(platform, model, { ...app, biasScore: 2 }).biasScore).toBe(2);
  });

  test('a layer that only lists terms inherits the score already in effect', () => {
    expect(mergeVocabularies({ terms: ['a'], biasScore: 5 }, { terms: ['b'] }).biasScore).toBe(5);
  });

  test('falls back to the default score when no layer set one', () => {
    expect(mergeVocabularies(platform, app).biasScore).toBe(VOCABULARY_DEFAULT_BIAS_SCORE);
  });

  test('skips a disabled layer but keeps the others', () => {
    const merged = mergeVocabularies(platform, { ...model, enabled: false }, app);
    expect(merged.terms).toEqual(['IntraFind', 'iHub', 'Schadensfall']);
    // The disabled layer's bias score does not leak through either.
    expect(merged.biasScore).toBe(VOCABULARY_DEFAULT_BIAS_SCORE);
  });

  test('returns null when every layer is empty', () => {
    expect(mergeVocabularies(undefined, null, {})).toBeNull();
  });

  test('caps the merged list', () => {
    const layerA = Array.from({ length: VOCABULARY_MAX_TERMS }, (_, i) => `a-${i}`);
    expect(mergeVocabularies({ terms: layerA }, { terms: ['overflow'] }).terms).toHaveLength(
      VOCABULARY_MAX_TERMS
    );
  });
});

describe('buildContextBiasing', () => {
  test('renders the snake_case upstream payload', () => {
    expect(buildContextBiasing({ terms: ['Voxtral'], biasScore: 4 })).toEqual({
      words: ['Voxtral'],
      bias_score: 4
    });
  });

  test('returns null when nothing is configured, so the field is omitted', () => {
    expect(buildContextBiasing(null)).toBeNull();
    expect(buildContextBiasing({ terms: [] })).toBeNull();
  });
});

describe('config schemas accept a vocabulary at each level', () => {
  const transcriptionModel = {
    id: 'voxtral-mini-realtime',
    modelId: 'mistralai/Voxtral-Mini-4B-Realtime-2602',
    name: { en: 'Voxtral' },
    description: { en: 'd' },
    url: 'ws://localhost:8080/v1/realtime',
    provider: 'vllm-realtime',
    modelType: 'transcription',
    enabled: true
  };
  const app = {
    id: 'claims',
    name: { en: 'Claims' },
    description: { en: 'd' },
    color: '#4F46E5',
    icon: 'chat',
    system: { en: 's' }
  };

  test('model: a transcription model may carry one', () => {
    const r = modelConfigSchema.safeParse({
      ...transcriptionModel,
      vocabulary: { enabled: true, terms: ['Voxtral'], biasScore: 4 }
    });
    expect(r.success).toBe(true);
    expect(r.data.vocabulary.terms).toEqual(['Voxtral']);
  });

  test('model: a chat model may not — the field would be silently ignored', () => {
    const r = modelConfigSchema.safeParse({
      id: 'gpt',
      modelId: 'gpt',
      name: { en: 'g' },
      description: { en: 'd' },
      url: 'https://api.openai.com/v1',
      provider: 'openai',
      vocabulary: { terms: ['Voxtral'] }
    });
    expect(r.success).toBe(false);
  });

  test('model: an out-of-range bias score is rejected', () => {
    const r = modelConfigSchema.safeParse({
      ...transcriptionModel,
      vocabulary: { terms: ['Voxtral'], biasScore: 50 }
    });
    expect(r.success).toBe(false);
  });

  test('model: the bias score stays absent when unset, so merging can inherit', () => {
    const r = modelConfigSchema.safeParse({
      ...transcriptionModel,
      vocabulary: { terms: ['Voxtral'] }
    });
    expect(r.success).toBe(true);
    expect(r.data.vocabulary.biasScore).toBeUndefined();
  });

  test('app: the transcription block may carry one', () => {
    const r = appConfigSchema.safeParse({
      ...app,
      transcription: { enabled: true, vocabulary: { terms: ['Schadensfall'] } }
    });
    expect(r.success).toBe(true);
    expect(r.data.transcription.vocabulary.terms).toEqual(['Schadensfall']);
  });

  test('platform: speech.realtime may carry one', () => {
    const r = platformConfigSchema.safeParse({
      speech: { realtime: { enabled: true, vocabulary: { terms: ['IntraFind'], biasScore: 2 } } }
    });
    expect(r.success).toBe(true);
    expect(r.data.speech.realtime.vocabulary).toEqual({ terms: ['IntraFind'], biasScore: 2 });
  });

  test('unknown vocabulary keys are rejected rather than silently dropped', () => {
    const r = modelConfigSchema.safeParse({
      ...transcriptionModel,
      vocabulary: { terms: ['Voxtral'], biasScoreTypo: 4 }
    });
    expect(r.success).toBe(false);
  });
});
