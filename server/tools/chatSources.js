// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `chat_sources_list` and `chat_sources_read`: the sources earlier answers of
 * the chat found, as they are stored on each answer (`sources`, see
 * `services/chat/chatSources.js`). See `services/chat/chatContextTools.js`.
 *
 * A read reports the source again (`sources` envelope,
 * `services/sources/producers/envelope.js`), as it was stored — provider,
 * privacy and reference included — so the new answer can cite it.
 *
 * @module tools/chatSources
 */
import {
  NO_STORED_CHAT,
  chatContextError,
  readableChat,
  turnsOf
} from '../services/chat/chatContextTools.js';

const MAX_LIMIT = 100;

/** The answers of the chat that found sources, oldest first, with their turn. */
async function answersWithSources(params) {
  const readable = await readableChat({ chatId: params.chatId, user: params.user });
  if (!readable) return null;
  const { messages } = await readable.repository.getMessages(params.chatId);
  const turns = turnsOf(messages);
  return (messages || [])
    .map((message, index) => ({ message, turn: turns[index] }))
    .filter(({ message }) => message?.role === 'assistant' && message.sources?.items?.length > 0);
}

function matches(source, query) {
  if (!query) return true;
  const needle = query.toLowerCase();
  return [source.title, source.url, source.site, source.snippet, source.fileName].some(
    value => typeof value === 'string' && value.toLowerCase().includes(needle)
  );
}

/** Characters of passages one read returns at most (the loop spills larger results). */
const MAX_PASSAGE_CHARS = 24000;

/** The stored passages of a source, as many as fit {@link MAX_PASSAGE_CHARS}. */
function boundedPassages(passages) {
  const out = [];
  let used = 0;
  for (const passage of Array.isArray(passages) ? passages : []) {
    const text = typeof passage?.text === 'string' ? passage.text : '';
    if (!text) continue;
    if (used + text.length > MAX_PASSAGE_CHARS) break;
    used += text.length;
    out.push({ text });
  }
  return out;
}

/** A source as the list shows it. */
function listedSource(source) {
  return {
    id: source.id,
    ...(source.title ? { title: source.title } : {}),
    ...(source.url ? { url: source.url } : {}),
    ...(source.site ? { site: source.site } : {}),
    ...(source.fileName ? { fileName: source.fileName } : {}),
    kind: source.kind,
    provider: source.provider,
    cited: source.cited === true,
    ...(source.read ? { read: source.read.ok === true } : {})
  };
}

/**
 * `chat_sources_list`
 *
 * @param {{turn?: number, query?: string, limit?: number, user: Object, chatId: string}} params
 */
export async function list(params) {
  try {
    const answers = await answersWithSources(params);
    if (!answers) return NO_STORED_CHAT;
    const query = typeof params.query === 'string' ? params.query.trim() : '';
    const limit = Math.min(Math.max(1, Number(params.limit) || 30), MAX_LIMIT);
    const turn = Number.isInteger(params.turn) ? params.turn : null;
    const turns = [];
    let total = 0;
    let returned = 0;
    // Newest first: a reference to "the source" usually means the last answer's.
    for (const { message, turn: at } of [...answers].reverse()) {
      if (turn !== null && at !== turn) continue;
      const found = message.sources.items.filter(source => matches(source, query));
      total += found.length;
      const room = limit - returned;
      if (room <= 0 || found.length === 0) continue;
      const items = found.slice(0, room).map(listedSource);
      returned += items.length;
      turns.push({
        turn: at,
        ...(message.ts ? { ts: message.ts } : {}),
        ...(message.sources.queries?.length ? { queries: message.sources.queries } : {}),
        sources: items
      });
    }
    return {
      turns,
      total,
      ...(total > returned
        ? { note: `${total - returned} more sources match: narrow by turn or query.` }
        : {}),
      ...(total === 0 ? { note: 'No earlier source matches.' } : {})
    };
  } catch (error) {
    return chatContextError(error.message || 'The sources could not be listed.', 'LIST_FAILED');
  }
}

/**
 * `chat_sources_read`
 *
 * @param {{id: string, turn?: number, user: Object, chatId: string}} params
 */
export async function read(params) {
  try {
    const id = typeof params.id === 'string' ? params.id.trim() : '';
    if (!id) return chatContextError('id is required', 'INVALID_REF');
    const answers = await answersWithSources(params);
    if (!answers) return NO_STORED_CHAT;
    const turn = Number.isInteger(params.turn) ? params.turn : null;
    let hit = null;
    for (const { message, turn: at } of [...answers].reverse()) {
      if (turn !== null && at !== turn) continue;
      const source = message.sources.items.find(candidate => candidate.id === id);
      if (source) {
        hit = { source, turn: at, message };
        break;
      }
    }
    if (!hit) {
      return chatContextError(
        `No earlier source has the id "${id}"${turn !== null ? ` in turn ${turn}` : ''}. List them with chat_sources_list.`,
        'SOURCE_NOT_FOUND'
      );
    }
    // What the earlier answer made of the source is that answer's, not this one's.
    const { cited: _cited, markers: _markers, passages, ...stored } = hit.source;
    const kept = boundedPassages(passages);
    const pageNote =
      stored.url && stored.kind === 'page'
        ? 'Only this excerpt of the page is kept. For more of the page, read its url again with the page reader if it is available.'
        : null;
    return {
      turn: hit.turn,
      ...(hit.message.sources.queries?.length ? { queries: hit.message.sources.queries } : {}),
      source: { ...stored, ...(kept.length ? { passages: kept } : {}) },
      ...(pageNote ? { note: pageNote } : {}),
      // Reported again for the sources panel and the citations, without the
      // passages the model already reads above.
      sources: [stored]
    };
  } catch (error) {
    return chatContextError(error.message || 'The source could not be read.', 'READ_FAILED');
  }
}
