/**
 * Which language a message is written in, so read aloud can pick the voice
 * configured for it (`tts.voices`). Voxtral TTS reads the language from the
 * text and takes no language parameter, but a voice keeps its own accent: an
 * English preset reads German correctly, with an English accent. A native
 * voice per language fixes that, which needs the language first.
 *
 * Deliberately small: the nine languages Voxtral speaks, told apart by script
 * (Arabic, Devanagari) and otherwise by their most frequent short words. A
 * word shared by several languages ("de", "la", "e") counts for each of them
 * in proportion. Detection decides only when one language clearly leads;
 * otherwise the caller's hint (the user's UI language) or the default voice
 * applies.
 */

/** Languages Voxtral TTS speaks. */
export const TTS_LANGUAGES = ['en', 'de', 'fr', 'es', 'it', 'nl', 'pt', 'hi', 'ar'];

const STOPWORDS = {
  en: 'the and is are was were of to that it with for on this you be have not as at by from or which can will they their would there what been has had',
  de: 'der die das und ist nicht ein eine einen mit sich auf für von den dem des zu im auch sie wir ich werden wird sind oder aber wenn dass kann noch nach bei wie über',
  fr: 'le la les et est des une un du dans que qui pour pas sur avec ce cette sont au aux il elle nous vous mais ou être plus par se ont',
  es: 'el la los las y es que de en un una por con para no se lo del al como más pero sus este esta está son también hay muy',
  it: 'il lo la gli le e è di che un una per non con del della sono anche come più ma questo questa nel alla dei delle ha',
  nl: 'de het een en van is dat niet op met voor zijn er maar ook als bij om naar wordt worden deze dit wel heeft kan',
  pt: 'o a os as e é de do da dos das que um uma para com não em no na por mais como mas são também você ao pelo'
};

// word → [languages that use it]
const WORD_LANGUAGES = new Map();
for (const [language, words] of Object.entries(STOPWORDS)) {
  for (const word of words.split(' ')) {
    const list = WORD_LANGUAGES.get(word) || [];
    list.push(language);
    WORD_LANGUAGES.set(word, list);
  }
}

/** Letters only one of the Latin-script languages uses. */
const MARKERS = [
  [/[äöüß]/g, 'de'],
  [/[ñ¿¡]/g, 'es'],
  [/[ãõ]/g, 'pt'],
  [/[œêîû]/g, 'fr']
];

/** How much of the start of a message is looked at. */
const SAMPLE_CHARACTERS = 3000;
/** Weighted word hits the leader needs before detection decides. */
const MIN_SCORE = 2;
/** How far the leader must be ahead of the runner-up. */
const MIN_LEAD = 1.5;

/** `de-DE` → `de`; anything else that is not a TTS language → null. */
export function normalizeLanguage(value) {
  if (typeof value !== 'string') return null;
  const base = value.trim().toLowerCase().split(/[-_]/)[0];
  return TTS_LANGUAGES.includes(base) ? base : null;
}

/**
 * @param {string} text - Speakable text (Markdown already removed).
 * @param {{ hint?: string }} [opts] - The user's UI language, used when the
 *   text alone does not decide.
 * @returns {string|null} A language from {@link TTS_LANGUAGES}, or null.
 */
export function detectSpeechLanguage(text, { hint } = {}) {
  const fallback = normalizeLanguage(hint);
  if (typeof text !== 'string' || !text.trim()) return fallback;
  const sample = text.slice(0, SAMPLE_CHARACTERS);

  // Scripts first: they are unambiguous.
  const letters = (sample.match(/\p{L}/gu) || []).length;
  if (letters) {
    const arabic = (sample.match(/[؀-ۿ]/g) || []).length;
    const devanagari = (sample.match(/[ऀ-ॿ]/g) || []).length;
    if (arabic / letters > 0.3) return 'ar';
    if (devanagari / letters > 0.3) return 'hi';
  }

  const scores = {};
  const lower = sample.toLowerCase();
  for (const word of lower.match(/\p{L}+/gu) || []) {
    const languages = WORD_LANGUAGES.get(word);
    if (!languages) continue;
    for (const language of languages) {
      scores[language] = (scores[language] || 0) + 1 / languages.length;
    }
  }
  for (const [pattern, language] of MARKERS) {
    const hits = (lower.match(pattern) || []).length;
    if (hits) scores[language] = (scores[language] || 0) + Math.min(hits, 10) * 0.5;
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  if (!best || best[1] < MIN_SCORE) return fallback;
  if (second && best[1] < second[1] * MIN_LEAD) {
    // Too close to call: the hint wins if it is one of the two.
    if (fallback && (fallback === best[0] || fallback === second[0])) return fallback;
    return best[0];
  }
  return best[0];
}

/**
 * The voice for a message: the one configured for its language, else the
 * model's voice.
 *
 * @param {{ voice?: string, voices?: Object<string, string> }} [tts]
 * @param {string|null} language
 * @returns {string|undefined}
 */
export function selectVoice(tts, language) {
  const byLanguage = language && tts?.voices ? tts.voices[language] : undefined;
  return byLanguage || tts?.voice || undefined;
}

export default { TTS_LANGUAGES, normalizeLanguage, detectSpeechLanguage, selectVoice };
