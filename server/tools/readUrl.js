// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The `read_url` tool: the model-facing door to the page reader
 * (`services/pageReader/pageReader.js`). It checks what the model passed and
 * shapes a bot-protection refusal into a result; the reading itself is the
 * platform's.
 */
import { normalizeFocus } from '../services/knowledge/focusQuery.js';
import { readWebPage } from '../services/pageReader/pageReader.js';
import {
  BOT_PROTECTION_CODE,
  botProtectionToolResult
} from '../services/pageReader/botProtection.js';

/** Bounds of the model-facing `maxLength` (mirrors defaults/tools/read_url.json). */
const TOOL_MIN_LENGTH = 500;
const TOOL_MAX_LENGTH = 50000;
const TOOL_DEFAULT_LENGTH = 10000;

/**
 * Entry point for the `read_url` tool the model calls.
 *
 * Tool arguments come straight from the model, and nothing validates them
 * against the schema, so this wrapper does it for the arguments that matter:
 * `focus` is trimmed and cut at 500 characters (empty means none), and
 * `maxLength` is clamped to the schema's bounds (an oversized value would
 * otherwise land a whole PDF in the context), `offset` to a whole number of
 * characters from the start, and `ignoreSSL` is never taken from the model —
 * certificate checking stays with the platform's `ssl.ignoreInvalidCertificates`
 * setting and the SSL domain whitelist.
 *
 * @param {Object} params - Tool arguments plus the runtime context runTool adds
 * @returns {Promise<Object>} Same result as {@link readWebPage}
 */
export async function readUrl({ url, uri, link, maxLength, offset, focus, language, chatId } = {}) {
  let length = Number(maxLength);
  if (!Number.isFinite(length)) length = TOOL_DEFAULT_LENGTH;
  length = Math.min(TOOL_MAX_LENGTH, Math.max(TOOL_MIN_LENGTH, Math.floor(length)));
  const start = Number(offset);
  const targetUrl = url || uri || link;

  try {
    return await readWebPage({
      url,
      uri,
      link,
      maxLength: length,
      offset: Number.isFinite(start) && start > 0 ? Math.floor(start) : 0,
      focus: normalizeFocus(focus),
      language,
      chatId
    });
  } catch (error) {
    if (error.code !== BOT_PROTECTION_CODE) throw error;
    // Handed to the model as a result it cannot misread as "try again", not
    // as a thrown error string.
    return botProtectionToolResult(error, targetUrl);
  }
}
