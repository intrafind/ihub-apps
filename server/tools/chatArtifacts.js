// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `chat_artifacts_list` and `chat_artifacts_read`: the files the turns of the
 * chat created — those still held from this turn and the stored artifacts
 * (`services/artifacts/ArtifactRepository.js`), as `create_zip` finds them
 * (`chatArtifactCandidates`). See `services/chat/chatContextTools.js`.
 *
 * Artifacts are write-once: the model changes a file by creating a new one.
 *
 * @module tools/chatArtifacts
 */
import {
  NO_STORED_CHAT,
  chatContextError,
  pageOfText,
  readableChat,
  turnsOf
} from '../services/chat/chatContextTools.js';
import { chatArtifactCandidates, selectChatFiles } from '../services/documents/files/fileTools.js';
import { extractText } from '../services/projects/extractText.js';
import { TEXT_FILE_MEDIA_TYPES } from '../../shared/generatedFiles.js';

/** Kinds that hold no text to read. */
const UNREADABLE_KINDS = new Set(['image', 'archive']);

/** Text this tool reads of one file at most, before paging. */
const MAX_EXTRACTED_CHARS = 2_000_000;

/** The files of the chat, newest first, or null when the chat is not the caller's. */
async function artifactsOf(params) {
  const candidates = await chatArtifactCandidates({
    user: params.user,
    chatId: params.chatId,
    intent: 'read'
  });
  if (candidates.length) return candidates;
  // Nothing found: say whether the chat is out of reach or just has no files.
  const readable = await readableChat({ chatId: params.chatId, user: params.user });
  return readable ? [] : null;
}

/** The turn that produced each run, by run id. */
async function runTurns(params) {
  const readable = await readableChat({ chatId: params.chatId, user: params.user });
  if (!readable) return new Map();
  const { messages } = await readable.repository.getMessages(params.chatId);
  const turns = turnsOf(messages);
  const byRun = new Map();
  (messages || []).forEach((message, index) => {
    if (message?.role === 'assistant' && typeof message.runId === 'string') {
      byRun.set(message.runId, turns[index]);
    }
  });
  return byRun;
}

/** One file per name, the newest (candidates come newest first). */
function newestPerName(candidates) {
  const seen = new Set();
  return candidates.filter(candidate => {
    const key = String(candidate.name || candidate.id).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * `chat_artifacts_list`
 *
 * @param {{kind?: string, query?: string, user: Object, chatId: string}} params
 */
export async function list(params) {
  try {
    const candidates = await artifactsOf(params);
    if (!candidates) return NO_STORED_CHAT;
    const query = typeof params.query === 'string' ? params.query.trim().toLowerCase() : '';
    const kind = typeof params.kind === 'string' ? params.kind : '';
    const turns = await runTurns(params);
    const files = newestPerName(candidates)
      .filter(candidate => !kind || candidate.kind === kind)
      .filter(
        candidate =>
          !query ||
          String(candidate.name || '')
            .toLowerCase()
            .includes(query)
      )
      .map(candidate => ({
        id: candidate.id,
        name: candidate.name,
        kind: candidate.kind,
        ...(candidate.mimeType ? { mimeType: candidate.mimeType } : {}),
        bytes: candidate.bytes,
        ...(candidate.held
          ? { turn: 'current' }
          : turns.has(candidate.runId)
            ? { turn: turns.get(candidate.runId) }
            : {}),
        ...(candidate.createdAt ? { createdAt: candidate.createdAt } : {})
      }));
    return files.length
      ? { files }
      : {
          files: [],
          note: query || kind ? 'No created file matches.' : 'No file was created in this chat.'
        };
  } catch (error) {
    return chatContextError(error.message || 'The files could not be listed.', 'LIST_FAILED');
  }
}

/** Whether a file's bytes are text as they are. */
function isPlainText(candidate) {
  const type = String(candidate.mimeType || '').toLowerCase();
  return (
    candidate.kind === 'code' ||
    type.startsWith('text/') ||
    TEXT_FILE_MEDIA_TYPES.includes(type) ||
    type === 'application/json'
  );
}

/** The text of a created file. */
async function textOf(candidate, data) {
  if (isPlainText(candidate)) return data.toString('utf8');
  const { text } = await extractText(
    { bytes: data, contentType: candidate.mimeType, name: candidate.name },
    { maxChars: MAX_EXTRACTED_CHARS }
  );
  return text;
}

/**
 * `chat_artifacts_read`
 *
 * @param {{artifact: string, offset?: number, user: Object, chatId: string}} params
 */
export async function read(params) {
  try {
    const wanted = typeof params.artifact === 'string' ? params.artifact.trim() : '';
    if (!wanted) return chatContextError('artifact is required', 'INVALID_REF');
    const candidates = await artifactsOf(params);
    if (!candidates) return NO_STORED_CHAT;
    let candidate;
    try {
      [candidate] = selectChatFiles(candidates, [wanted], false);
    } catch (error) {
      return chatContextError(error.message, 'ARTIFACT_NOT_FOUND');
    }
    const described = {
      id: candidate.id,
      name: candidate.name,
      kind: candidate.kind,
      ...(candidate.mimeType ? { mimeType: candidate.mimeType } : {})
    };
    if (UNREADABLE_KINDS.has(candidate.kind)) {
      return {
        ...described,
        text: '',
        note: `This file is ${candidate.kind === 'image' ? 'an image' : 'an archive'} and cannot be read as text.`
      };
    }
    const data = await candidate.load();
    if (!data) {
      return chatContextError(`The file "${candidate.name}" is no longer stored.`, 'ARTIFACT_GONE');
    }
    const page = pageOfText(await textOf(candidate, data), params.offset);
    return {
      ...described,
      ...page,
      ...(page.nextOffset !== undefined
        ? {
            continue: `More follows: call chat_artifacts_read again with offset ${page.nextOffset}.`
          }
        : {})
    };
  } catch (error) {
    return chatContextError(error.message || 'The file could not be read.', 'READ_FAILED');
  }
}
