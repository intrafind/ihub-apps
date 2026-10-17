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

const normalize = value =>
  String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The answer to a spoken question the app asked (`ask_user`). A question with
 * options is answered by saying one: the first option whose label (or value)
 * equals what was said, else the one the spoken words contain, else — when
 * the question allows another answer — the words themselves. Without options
 * the words are the answer.
 *
 * @param {string} spoken - The final transcript.
 * @param {{ options?: Array<{ value?: any, label?: any }|string>, allowOther?: boolean }|null} clarification
 * @returns {{ value: any, displayText: string }}
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
  const said = normalize(words);
  const byLabel = entries.find(
    entry => normalize(entry.label) === said || normalize(entry.value) === said
  );
  const contained =
    byLabel ||
    entries.find(entry => {
      const label = normalize(entry.label);
      return label.length > 0 && said.includes(label);
    });
  if (contained) return { value: contained.value, displayText: String(contained.label) };
  return { value: words, displayText: words };
}
