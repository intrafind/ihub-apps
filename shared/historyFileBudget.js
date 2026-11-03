// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * How much of the context window the files of earlier turns may take.
 *
 * Every user message of a chat carries its files (`fileData`) back to the
 * model on every later turn. Without a limit a chat with a few large
 * documents fills the context window, and compaction never shortens a user
 * message, so it cannot recover. This keeps the files of the turn being
 * answered in full, and the files of earlier turns newest first while they
 * fit a share of the context window; an older file is replaced by a stub
 * (`omitted: true`) that names it, which `renderUserMessage` renders as an
 * empty `<content … omitted="true"/>` block. The model reads such a file
 * with the `chat_files_read` tool when it needs it.
 *
 * Pure and cheap (characters / 4, no tokenizer), so the server and the
 * client's context meter apply the same budget to the same messages.
 *
 * @module shared/historyFileBudget
 */

/** Share of the context window the files of earlier turns may take. */
export const HISTORY_FILE_BUDGET_RATIO = 0.25;

/** The budget never drops below this many tokens (small context windows). */
export const HISTORY_FILE_BUDGET_MIN_TOKENS = 8000;

/** What one page image is counted as; image tokens are provider-specific. */
const PAGE_IMAGE_TOKENS = 1000;

/** Files that render as the host item they came from, not as documents: never stubbed. */
const HOST_ITEM_ORIGINS = new Set(['email', 'meeting', 'page']);

/**
 * The token budget for the files of earlier turns.
 *
 * @param {number} contextWindow - The model's context window in tokens.
 * @returns {number|null} null when the window is unknown (no budget applies).
 */
export function historyFileBudgetTokens(contextWindow) {
  const window = Number(contextWindow);
  if (!Number.isFinite(window) || window <= 0) return null;
  return Math.max(HISTORY_FILE_BUDGET_MIN_TOKENS, Math.floor(window * HISTORY_FILE_BUDGET_RATIO));
}

/**
 * Rough token count of one `fileData` entry.
 *
 * @param {Object} file
 * @returns {number}
 */
export function estimateFileTokens(file) {
  const chars = typeof file?.content === 'string' ? file.content.length : 0;
  const images = Array.isArray(file?.pageImages) ? file.pageImages.length : 0;
  return Math.ceil(chars / 4) + images * PAGE_IMAGE_TOKENS;
}

/**
 * The stub that stands in for a file of an earlier turn.
 *
 * @param {Object} file - A `fileData` entry with an id.
 * @returns {Object}
 */
export function omittedFileStub(file) {
  const id = file.fileId || file.id;
  const name = file.fileName || file.name;
  return {
    id,
    fileId: id,
    ...(name ? { fileName: name, name } : {}),
    ...(file.fileType ? { fileType: file.fileType } : {}),
    ...(file.displayType ? { displayType: file.displayType } : {}),
    type: 'document',
    origin: file.origin,
    omitted: true,
    textChars: typeof file.content === 'string' ? file.content.length : 0,
    ...(Array.isArray(file.pageImages) && file.pageImages.length > 0
      ? { pageImageCount: file.pageImages.length }
      : {})
  };
}

/**
 * Whether a file can be replaced by a stub: it can be read again by its id,
 * it is a document (not an email, meeting or page) and it has something to omit.
 */
function stubbable(file) {
  if (!file || typeof file !== 'object' || file.omitted) return false;
  if (typeof (file.fileId || file.id) !== 'string') return false;
  if (HOST_ITEM_ORIGINS.has(file.origin)) return false;
  return estimateFileTokens(file) > 0;
}

/**
 * Keep the files of earlier turns within the budget.
 *
 * The last user message (the turn being answered) keeps all its files. The
 * user messages before it are walked newest first, and each file stays as
 * long as the running total fits the budget; every file after that becomes
 * a stub. Files that cannot be read again (no id) or that are not documents
 * always stay.
 *
 * @param {Array<Object>} messages - Chat messages (`role`, `content`, `fileData`).
 * @param {Object} options
 * @param {number} [options.contextWindow] - The model's context window.
 * @param {number} [options.budgetTokens] - An explicit budget (tests); wins over the window.
 * @returns {{messages: Array<Object>, omitted: number}} New messages (the
 *   input is not changed) and how many files were replaced by a stub.
 */
export function applyHistoryFileBudget(messages, { contextWindow, budgetTokens } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const budget = Number.isFinite(budgetTokens)
    ? budgetTokens
    : historyFileBudgetTokens(contextWindow);
  if (budget === null) return { messages: list, omitted: 0 };

  let lastUser = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role === 'user') {
      lastUser = i;
      break;
    }
  }

  const out = [...list];
  let used = 0;
  let omitted = 0;
  for (let i = lastUser - 1; i >= 0; i--) {
    const message = list[i];
    if (message?.role !== 'user' || !message.fileData) continue;
    const files = Array.isArray(message.fileData) ? message.fileData : [message.fileData];
    let changed = false;
    const kept = files.map(file => {
      if (!stubbable(file)) return file;
      const tokens = estimateFileTokens(file);
      if (used + tokens <= budget) {
        used += tokens;
        return file;
      }
      changed = true;
      omitted += 1;
      return omittedFileStub(file);
    });
    if (changed) out[i] = { ...message, fileData: kept };
  }
  return { messages: out, omitted };
}
