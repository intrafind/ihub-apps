// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Small pure helpers that turn what the chat holds (an answer, a tool run, a
 * question the app asked) into what voice mode says and shows.
 */

/**
 * The answer as it is spoken: citation markers (`[1](https://…)`, `[2]`) are
 * links the chat renders as badges, and read aloud they would be a stray digit
 * after every claim. The text stays Markdown otherwise — the server strips
 * the rest (`toSpeechText`).
 *
 * @param {string} text
 * @returns {string}
 */
export function toSpokenText(text) {
  if (typeof text !== 'string' || !text) return '';
  return text.replace(/\s?\[\d+\]\([^)\s]*\)/g, '').replace(/\s?\[\d+\](?!\()/g, '');
}

/**
 * What the app is doing while it works on an answer, from the assistant
 * message the chat projects the run onto: `{ kind, scope }` of the tool
 * that is running now, or null. `kind` is `search`, `fetch` or `tool`; `scope`
 * tells a web search from a look in the organisation's documents.
 *
 * @param {Object|null} message
 * @returns {{ kind: 'search'|'fetch'|'tool', scope: 'web'|'documents'|null }|null}
 */
export function activeToolOf(message) {
  if (!message || message.loading === false) return null;
  const items = Array.isArray(message.toolActivity?.items) ? message.toolActivity.items : [];
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item?.status === 'running') {
      return { kind: item.kind || 'tool', scope: item.scope || null };
    }
  }
  if (message.searchStatus) return { kind: 'search', scope: 'web' };
  return null;
}

/** The i18n key and default of the status label for a running tool. */
export function toolStatusLabel(tool, t) {
  if (tool.kind === 'search' && tool.scope === 'documents') {
    return t('voiceMode.tools.searchDocuments', 'Looking in the documents…');
  }
  if (tool.kind === 'search') return t('voiceMode.tools.searchWeb', 'Searching the web…');
  if (tool.kind === 'fetch') return t('voiceMode.tools.readPage', 'Reading a page…');
  return t('voiceMode.tools.working', 'Working on it…');
}

/**
 * Lower case, no accents, letters and digits only, single spaces. Accents are
 * dropped rather than turned into separators: a combining mark that became a
 * space would cut "für" into "fu r" and let a one-letter option match inside it.
 */
const normalize = value =>
  String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Words that may stand in front of a one-character option ("option a", "Antwort b"). */
const CHOICE_PREFIXES = [
  'option',
  'choice',
  'letter',
  'answer',
  'number',
  'variant',
  'antwort',
  'nummer',
  'buchstabe',
  'variante',
  'wahl'
];

/** Input types whose answer is free text, whatever options came with the question. */
const FREE_TEXT_INPUT_TYPES = ['text', 'number', 'date', 'date_range'];

/**
 * Whether `label` (normalised) is said in `said` (normalised). Whole words only:
 * "no" is not in "know", "yes" is not in "yesterday". A one-character label
 * ("A", "2") is in every other sentence ("I want a large one"), so it only counts
 * when it is the whole answer or follows a word such as "option".
 */
function isSaid(said, label) {
  if (!label) return false;
  if (label.length < 2) {
    return said === label || CHOICE_PREFIXES.some(prefix => said === `${prefix} ${label}`);
  }
  return ` ${said} `.includes(` ${label} `);
}

/** Whether the question can be answered with words that are none of its options. */
const allowsFreeText = clarification =>
  clarification?.allowOther === true || FREE_TEXT_INPUT_TYPES.includes(clarification?.inputType);

/**
 * The options the spoken words name: the one whose label (or value) is what was
 * said, else every option whose label the words contain as whole words. An
 * option whose label is part of a longer matching label does not count on its
 * own ("large" in "extra large").
 */
function namedOptions(entries, said) {
  const labelled = entries.map(entry => ({ entry, label: normalize(entry.label) }));
  if (said) {
    const exact = labelled.find(
      ({ entry, label }) => label === said || normalize(entry.value) === said
    );
    if (exact) return [exact.entry];
  }
  const hits = labelled.filter(({ label }) => isSaid(said, label));
  const specific = hits.filter(
    hit =>
      !hits.some(other => other.label.length > hit.label.length && isSaid(other.label, hit.label))
  );
  return [...new Map(specific.map(({ entry }) => [String(entry.value), entry])).values()];
}

/** The one option the spoken words name, or null when none or several do ("yes or no"). */
function matchOption(entries, said) {
  const named = namedOptions(entries, said);
  return named.length === 1 ? named[0] : null;
}

/**
 * The answer to a multi-select question: every option the words name, in the
 * order of the options ("red and blue"). The server turns an answer with fewer
 * or more selections than the question allows (`validation.min` / `max`) down,
 * and a person who cannot see the options would not know why, so such an answer
 * is not understood and the question is asked again.
 */
function answerForMultiSelect(words, entries, clarification) {
  const named = namedOptions(entries, normalize(words));
  if (named.length === 0) {
    return allowsFreeText(clarification) ? { value: [words], displayText: words } : null;
  }
  const { min, max } = clarification.validation || {};
  if (typeof min === 'number' && named.length < min) return null;
  if (typeof max === 'number' && named.length > max) return null;
  return {
    value: named.map(entry => entry.value),
    displayText: named.map(entry => String(entry.label)).join(', ')
  };
}

/**
 * The answer to a spoken question the app asked (`ask_user`). A question with
 * options is answered by saying one: the option whose label (or value) is what
 * was said, else the single option whose label the spoken words contain as
 * whole words. A wrong answer would reach the model as if the user had given
 * it, so a sentence that names no option, or two, is not guessed at: the words
 * themselves are the answer when the question allows another answer, otherwise
 * `null` ("not understood") and the caller asks again. Without options the
 * words are the answer. A multi-select question takes every option named, as an
 * array (see `answerForMultiSelect`).
 *
 * @param {string} spoken - The final transcript.
 * @param {{ options?: Array<{ value?: any, label?: any }|string>, allowOther?: boolean, inputType?: string, validation?: { min?: number, max?: number } }|null} clarification
 * @returns {{ value: any, displayText: string }|null} `null`: not understood.
 */
export function answerForClarification(spoken, clarification) {
  const words = String(spoken ?? '').trim();
  const options = Array.isArray(clarification?.options) ? clarification.options : [];
  if (options.length === 0) return { value: words, displayText: words };

  const entries = options.map(option =>
    typeof option === 'string'
      ? { value: option, label: option }
      : { value: option?.value ?? option?.label, label: option?.label ?? String(option?.value) }
  );
  if (clarification?.inputType === 'multi_select') {
    return answerForMultiSelect(words, entries, clarification);
  }
  const matched = matchOption(entries, normalize(words));
  if (matched) return { value: matched.value, displayText: String(matched.label) };
  return allowsFreeText(clarification) ? { value: words, displayText: words } : null;
}
