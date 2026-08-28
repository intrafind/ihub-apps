import { useRef, useState } from 'react';
import {
  VOCABULARY_MAX_TERMS,
  formatVocabularyTerms,
  parseVocabularyTerms
} from '../../../../../shared/speechVocabulary.js';

/**
 * Editor for a speech-to-text custom vocabulary (vLLM "hotwords").
 *
 * One component for all three configuration levels — platform (Voice Input),
 * transcription model, and app — because they store the identical shape
 * `{ enabled, terms }` and the server merges them
 * (`shared/speechVocabulary.js`). Callers differ only in the `scopeHint` they
 * pass, which explains how that level combines with the others.
 *
 * Terms are edited as free text (one per line, commas also accepted) and stored
 * as an array. The textarea keeps its own draft state so an in-progress line —
 * a trailing newline, a half-typed term — survives re-renders instead of being
 * normalized away under the cursor.
 *
 * @param {Object} props
 * @param {{enabled?: boolean, terms?: string[]}} [props.value]
 * @param {(next: Object|undefined) => void} props.onChange - Called with the new
 *   vocabulary, or `undefined` once it holds nothing worth persisting.
 * @param {Function} props.t - Translation function.
 * @param {string} props.idPrefix - Prefix for input ids (unique per usage).
 * @param {string} [props.scopeHint] - Sentence describing how this level merges.
 */
function SpeechVocabularyEditor({ value, onChange, t, idPrefix, scopeHint }) {
  const terms = Array.isArray(value?.terms) ? value.terms : [];
  const serializedTerms = formatVocabularyTerms(terms);
  const [draft, setDraft] = useState(serializedTerms);
  // What we last pushed upward. An external change (a config finished loading)
  // differs from it and resets the draft; our own round-trip matches it and
  // leaves the textarea — and the cursor — alone. Adjusted during render rather
  // than in an effect so the textarea never paints one frame of stale text.
  const lastEmittedRef = useRef(serializedTerms);
  if (serializedTerms !== lastEmittedRef.current) {
    lastEmittedRef.current = serializedTerms;
    setDraft(serializedTerms);
  }

  // Emit a complete vocabulary, or `undefined` once it holds nothing worth
  // persisting, so config files don't accumulate empty blocks.
  const emit = next => {
    const isEmpty = !next.terms?.length && next.enabled !== false;
    onChange(isEmpty ? undefined : next);
  };

  const patch = updates => emit({ ...(value || {}), ...updates });

  const handleTermsChange = text => {
    setDraft(text);
    const parsed = parseVocabularyTerms(text);
    lastEmittedRef.current = formatVocabularyTerms(parsed);
    patch({ terms: parsed });
  };

  const enabled = value?.enabled !== false;
  const inputClass =
    'mt-1 block w-full rounded-md border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm';
  const labelClass = 'block text-sm font-medium text-gray-700 dark:text-gray-300';

  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {t('admin.speechVocabulary.title', 'Custom vocabulary')}
        </h4>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {t(
            'admin.speechVocabulary.description',
            'Terms the transcription model should pay extra attention to — product names, domain jargon, people. They are sent to the speech endpoint as hotwords so they are spelled correctly instead of guessed phonetically.'
          )}
          {scopeHint ? ` ${scopeHint}` : ''}
        </p>
      </div>

      <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        <input
          type="checkbox"
          checked={enabled}
          onChange={e => patch({ enabled: e.target.checked })}
          className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500"
        />
        {t('admin.speechVocabulary.enabled', 'Apply these terms')}
      </label>

      <div>
        <label className={labelClass} htmlFor={`${idPrefix}-vocabulary-terms`}>
          {t('admin.speechVocabulary.terms', 'Terms (one per line)')}
        </label>
        <textarea
          id={`${idPrefix}-vocabulary-terms`}
          rows={6}
          value={draft}
          onChange={e => handleTermsChange(e.target.value)}
          className={`${inputClass} font-mono`}
          placeholder={'Voxtral\nvLLM\nIntraFind'}
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {t('admin.speechVocabulary.termsHint', {
            // Not named `count`: that key switches i18next into plural
            // resolution, which this single sentence does not need.
            defaultValue:
              '{{used}} of {{max}} terms. Multi-word phrases are allowed. Spelling and capitalization matter — list a term the way it should appear in the transcript.',
            used: terms.length,
            max: VOCABULARY_MAX_TERMS
          })}
        </p>
      </div>

      <p className="text-xs text-amber-600 dark:text-amber-400">
        {t(
          'admin.speechVocabulary.upstreamSupportHint',
          'Requires a speech endpoint that applies hotwords to realtime sessions. A stock vLLM /v1/realtime build reads only the model from the session handshake and ignores this list.'
        )}
      </p>
    </div>
  );
}

export default SpeechVocabularyEditor;
