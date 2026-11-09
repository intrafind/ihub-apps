// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `chat_files_list` and `chat_files_read`: the files uploaded to the chat,
 * from the chat-file store (`services/chatFiles/ChatFileRepository.js`).
 * The files of earlier turns are inline only within a budget
 * (`shared/historyFileBudget.js`); a file left out is read here. See
 * `services/chat/chatContextTools.js`.
 *
 * @module tools/chatFiles
 */
import {
  NO_STORED_CHAT,
  chatContextError,
  pageOfText,
  readableChat,
  turnsOf
} from '../services/chat/chatContextTools.js';
import { uploadedFileScopes } from '../services/documents/templateFiles.js';

/** The chat's file store and the scopes a call may read, or null. */
async function filesOf(params) {
  const readable = await readableChat({ chatId: params.chatId, user: params.user });
  if (!readable) return null;
  const store = readable.repository.fileStore();
  if (!store?.isAvailable?.()) return null;
  return {
    repository: readable.repository,
    store,
    scopes: uploadedFileScopes({ user: params.user, chatId: params.chatId })
  };
}

/** The turn each file was attached in, by file id. */
async function fileTurns(repository, chatId) {
  const { messages } = await repository.getMessages(chatId);
  const turns = turnsOf(messages);
  const byId = new Map();
  (messages || []).forEach((message, index) => {
    if (message?.role !== 'user' || !Array.isArray(message.attachments)) return;
    for (const attachment of message.attachments) {
      const id = attachment?.id || attachment?.fileId;
      if (typeof id === 'string' && !byId.has(id)) byId.set(id, turns[index]);
    }
  });
  return byId;
}

/**
 * `chat_files_list`
 *
 * @param {{query?: string, user: Object, chatId: string}} params
 */
export async function list(params) {
  try {
    const files = await filesOf(params);
    if (!files) return NO_STORED_CHAT;
    const query = typeof params.query === 'string' ? params.query.trim().toLowerCase() : '';
    const turns = await fileTurns(files.repository, params.chatId);
    const listed = [];
    for (const scope of files.scopes) {
      for (const file of await files.store.list(scope)) {
        // A picture the user attached is kept for its thumbnail, not as a document to read
        if (file.origin === 'image') continue;
        if (
          query &&
          !String(file.name || '')
            .toLowerCase()
            .includes(query)
        )
          continue;
        listed.push({
          fileId: file.id,
          name: file.name,
          ...(file.formatLabel ? { format: file.formatLabel } : {}),
          bytes: file.bytes,
          ...(Number.isFinite(file.textBytes) ? { textBytes: file.textBytes } : {}),
          ...(file.pageImageCount ? { pageImages: file.pageImageCount } : {}),
          ...(file.origin && file.origin !== 'upload' ? { origin: file.origin } : {}),
          ...(turns.has(file.id) ? { turn: turns.get(file.id) } : {}),
          ...(file.createdAt ? { createdAt: file.createdAt } : {})
        });
      }
    }
    return listed.length
      ? { files: listed }
      : { files: [], note: query ? 'No file of this chat matches.' : 'This chat has no files.' };
  } catch (error) {
    return chatContextError(error.message || 'The files could not be listed.', 'LIST_FAILED');
  }
}

/**
 * `chat_files_read`
 *
 * @param {{fileId: string, offset?: number, user: Object, chatId: string}} params
 */
export async function read(params) {
  try {
    const fileId = typeof params.fileId === 'string' ? params.fileId.trim() : '';
    if (!fileId) return chatContextError('fileId is required', 'INVALID_REF');
    const files = await filesOf(params);
    if (!files) return NO_STORED_CHAT;
    let stored = null;
    for (const scope of files.scopes) {
      stored = await files.store.getText(scope, fileId);
      if (stored) break;
    }
    if (!stored) {
      return chatContextError(
        `This chat has no file with the id "${fileId}". List them with chat_files_list.`,
        'FILE_NOT_FOUND'
      );
    }
    const text = typeof stored.text === 'string' ? stored.text : '';
    if (!text) {
      return {
        fileId,
        name: stored.name,
        text: '',
        note:
          Array.isArray(stored.pageImages) && stored.pageImages.length > 0
            ? 'This file has no text layer (a scanned document): only its page images were kept, and they cannot be read with this tool.'
            : 'This file holds no text.'
      };
    }
    const page = pageOfText(text, params.offset);
    return {
      fileId,
      name: stored.name,
      ...(stored.formatLabel ? { format: stored.formatLabel } : {}),
      ...page,
      ...(stored.truncated
        ? { note: 'Only the beginning of this file was extracted when it was uploaded.' }
        : {}),
      ...(page.nextOffset !== undefined
        ? { continue: `More follows: call chat_files_read again with offset ${page.nextOffset}.` }
        : {})
    };
  } catch (error) {
    return chatContextError(error.message || 'The file could not be read.', 'READ_FAILED');
  }
}
