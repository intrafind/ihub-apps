// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Opt-in capture of prompt and completion content on the LLM span.
 *
 * Off by default (`telemetry.events.includePrompts` / `includeCompletions`).
 * When an admin turns it on for debugging, what reaches the trace backend is:
 *
 * - in the current GenAI semantic convention format: `gen_ai.input.messages`
 *   and `gen_ai.output.messages`, JSON arrays of `{ role, parts: [...] }`;
 * - **redacted**, best effort: e-mail addresses, phone numbers, IBANs, JWTs,
 *   bearer tokens, common API key formats and `key=value` secrets
 *   ({@link redactContent});
 * - **capped** at `events.maxEventSize` characters, and never more than
 *   {@link MAX_CONTENT_LENGTH} whatever the setting says. The newest messages
 *   are kept, older ones dropped first;
 * - without file or image data: a multimodal part becomes `{ type: 'blob',
 *   modality }`, tool call arguments are left out.
 *
 * Redaction is pattern-based and cannot recognise names, addresses or free-text
 * personal data. Keep capture off in production.
 *
 * @module telemetry/contentCapture
 */

import { MAX_CONTENT_ATTRIBUTE_LENGTH } from './spans.js';

/** Hard cap on one captured attribute, in characters. */
export const MAX_CONTENT_LENGTH = MAX_CONTENT_ATTRIBUTE_LENGTH;

/** Default `events.maxEventSize`. */
export const DEFAULT_MAX_EVENT_SIZE = 1024;

/**
 * Redaction rules, applied in order. Secrets first, so a token that contains
 * something e-mail-like is removed as a whole.
 *
 * No two adjacent repetitions can match the same characters and none is
 * nested, so a pattern runs in linear time on any input (the text is
 * conversation content, possibly crafted to stall a regex). A secret's value
 * is consumed to its end, however long, so no tail of it is left behind.
 */
const REDACTIONS = [
  // JSON Web Tokens (three base64url parts, header starts with `{"`)
  [/\beyJ[A-Za-z0-9_-]{5,4096}\.[A-Za-z0-9_-]{5,4096}\.[A-Za-z0-9_-]{5,4096}/g, '[REDACTED:jwt]'],
  // Authorization header values
  [/\b(Bearer|Basic) {1,4}[A-Za-z0-9._~+/=-]{8,4096}/gi, '$1 [REDACTED:token]'],
  // Well-known API key formats
  [
    /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,512}|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,255}|\bgithub_pat_[A-Za-z0-9_]{30,255}|\bxox[abprs]-[A-Za-z0-9-]{10,255}|\bAIza[0-9A-Za-z_-]{35}\b|\bglpat-[A-Za-z0-9_-]{20,255}/g,
    '[REDACTED:key]'
  ],
  // key=value / key: value secrets, also with a quoted (JSON) key. A quoted
  // value is replaced up to its closing quote (escaped quotes included), so
  // `&`, commas or blanks inside it leave nothing behind; an unquoted one up
  // to the first delimiter. Each quoted scan stops at the next quote.
  [
    /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd|pwd|token)["']?\s*[:=]\s*)(?:"(?:[^"\\\r\n]|\\.)+"|'(?:[^'\\\r\n]|\\.)+'|(["']?)[^\s"'&,;]{4,}["']?)/gi,
    (match, assignment, openQuote) => {
      const quote = openQuote ?? match.charAt(assignment.length);
      return /["']/.test(quote)
        ? `${assignment}${quote}[REDACTED:secret]${quote}`
        : `${assignment}[REDACTED:secret]`;
    }
  ],
  // E-mail addresses: the domain is matched as one run of labels and dots and
  // must end in a dot and a TLD, checked in the replacer (no nested repetition).
  [
    /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}/g,
    match => {
      // A sentence may end right after the address: keep its full stop.
      const email = match.replace(/[.-]+$/, '');
      const trailing = match.slice(email.length);
      return /\.[A-Za-z]{2,}$/.test(email) ? `[REDACTED:email]${trailing}` : match;
    }
  ],
  // IBANs, with or without the usual blanks every four characters
  [/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g, '[REDACTED:iban]']
];

/** A phone number candidate: international (+, 00) or national (leading 0) prefix. */
const PHONE_CANDIDATE = /(?<![\w+])(?:\+|00|0)\d[\d ()./-]{5,24}(?![\w])/g;
/** A date like 01.02.2024 or 1/2/24, which the candidate pattern would also match. */
const DATE_LIKE = /^\d{1,4}[./-]\d{1,2}[./-]\d{1,4}$/;

/**
 * Remove the personal data and secrets the patterns recognise. Best effort.
 *
 * @param {string} text
 * @returns {string}
 */
export function redactContent(text) {
  if (typeof text !== 'string' || text === '') return text;
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  out = out.replace(PHONE_CANDIDATE, candidate => {
    // The candidate may end in separators; they stay in the text.
    const match = candidate.replace(/[ ()./-]+$/, '');
    const tail = candidate.slice(match.length);
    const digits = match.replace(/\D/g, '').length;
    if (digits < 7 || digits > 15) return candidate;
    if (DATE_LIKE.test(match.trim())) return candidate;
    return `[REDACTED:phone]${tail}`;
  });
  return out;
}

/**
 * The cap in effect for one attribute: the configured size, never more than
 * {@link MAX_CONTENT_LENGTH}.
 *
 * @param {Object} [eventsConfig] - `telemetry.events`
 * @returns {number}
 */
export function contentCap(eventsConfig) {
  const configured = Number(eventsConfig?.maxEventSize);
  const size = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_EVENT_SIZE;
  return Math.min(Math.floor(size), MAX_CONTENT_LENGTH);
}

/** Whether the config captures prompts. */
export function capturesPrompts(config) {
  return config?.events?.enabled !== false && config?.events?.includePrompts === true;
}

/** Whether the config captures completions. */
export function capturesCompletions(config) {
  return config?.events?.enabled !== false && config?.events?.includeCompletions === true;
}

/** Map a message role to the semconv role. */
function roleOf(role) {
  if (role === 'system' || role === 'developer') return 'system';
  if (role === 'assistant' || role === 'model') return 'assistant';
  if (role === 'tool' || role === 'function') return 'tool';
  return 'user';
}

/** The semconv parts of one message's content, text redacted, binary data left out. */
function partsOf(message) {
  const parts = [];
  const content = message?.content;
  const isTool = roleOf(message?.role) === 'tool';
  const addText = text => {
    if (typeof text !== 'string' || text === '') return;
    parts.push(
      isTool
        ? { type: 'tool_call_response', response: redactContent(text) }
        : { type: 'text', content: redactContent(text) }
    );
  };
  if (typeof content === 'string') {
    addText(content);
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'string') addText(part);
      else if (part && typeof part === 'object') {
        if (typeof part.text === 'string') addText(part.text);
        else if (typeof part.content === 'string') addText(part.content);
        else parts.push({ type: 'blob', modality: modalityOf(part) });
      }
    }
  } else if (content && typeof content === 'object') {
    if (typeof content.text === 'string') addText(content.text);
    else parts.push({ type: 'blob', modality: modalityOf(content) });
  }
  const toolCalls = message?.tool_calls || message?.toolCalls;
  if (Array.isArray(toolCalls)) {
    for (const call of toolCalls) {
      const name = call?.function?.name || call?.name;
      parts.push({ type: 'tool_call', ...(typeof name === 'string' ? { name } : {}) });
    }
  }
  return parts;
}

function modalityOf(part) {
  const type = String(part?.type || part?.mimeType || part?.mime_type || '').toLowerCase();
  if (type.includes('image')) return 'image';
  if (type.includes('audio')) return 'audio';
  if (type.includes('video')) return 'video';
  return 'file';
}

/**
 * Serialise semconv messages within `cap` characters, newest first: older
 * messages are dropped and the oldest kept text part is cut to fit.
 *
 * @param {Array<{role: string, parts: Array<Object>}>} messages
 * @param {number} cap
 * @returns {string|undefined} JSON, or undefined when nothing fits
 */
export function serializeWithinCap(messages, cap) {
  const kept = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const candidate = [messages[index], ...kept];
    if (JSON.stringify(candidate).length <= cap) {
      kept.unshift(messages[index]);
      continue;
    }
    const cut = cutToFit(messages[index], kept, cap);
    if (cut) kept.unshift(cut);
    break;
  }
  if (kept.length === 0) return undefined;
  return JSON.stringify(kept);
}

/**
 * Where the longest suffix of `text` starts whose JSON encoding (without the
 * quotes) fits `budget` characters. Escapes count at their encoded length, so
 * a run of newlines early in the text does not crowd out the newest content.
 * At most `budget` characters are looked at.
 */
function suffixStart(text, budget) {
  let used = 0;
  let start = text.length;
  while (start > 0) {
    // One code point at a time: a surrogate pair is two characters encoded,
    // where either half alone would be escaped to six.
    const low = text.charCodeAt(start - 1);
    const high = start > 1 ? text.charCodeAt(start - 2) : 0;
    const width = low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff ? 2 : 1;
    const cost = JSON.stringify(text.slice(start - width, start)).length - 2;
    if (used + cost > budget) break;
    used += cost;
    start -= width;
  }
  return start;
}

/** A copy of `message` whose text is shortened so `[message, ...rest]` fits `cap`. */
function cutToFit(message, rest, cap) {
  const textKey = part => (part.type === 'tool_call_response' ? 'response' : 'content');
  const shell = {
    ...message,
    parts: message.parts.map(part =>
      typeof part[textKey(part)] === 'string' ? { ...part, [textKey(part)]: '' } : part
    )
  };
  let budget = cap - JSON.stringify([shell, ...rest]).length - '…'.length;
  if (budget <= 0) return undefined;
  const parts = [];
  // Keep the end of the text: the newest content of a long message is what
  // the model answered to.
  for (let index = message.parts.length - 1; index >= 0; index--) {
    const part = message.parts[index];
    const key = textKey(part);
    if (typeof part[key] !== 'string') {
      parts.unshift(part);
      continue;
    }
    const text = part[key];
    const start = suffixStart(text, budget);
    if (start === text.length && text.length > 0) {
      parts.unshift({ ...part, [key]: '' });
      continue;
    }
    const kept = start > 0 ? `…${text.slice(start)}` : text;
    budget -= JSON.stringify(text.slice(start)).length - 2 + (start > 0 ? '…'.length : 0);
    parts.unshift({ ...part, [key]: kept });
  }
  const cut = { ...message, parts };
  return JSON.stringify([cut, ...rest]).length <= cap ? cut : undefined;
}

/**
 * The `gen_ai.input.messages` attribute for a call's messages, or nothing when
 * prompt capture is off.
 *
 * @param {Array<Object>} messages - The call's messages (any provider-neutral shape)
 * @param {Object} config - The telemetry config
 * @returns {Object} `{ 'gen_ai.input.messages': string }` or `{}`
 */
export function inputMessagesAttributes(messages, config) {
  if (!capturesPrompts(config) || !Array.isArray(messages) || messages.length === 0) return {};
  const converted = messages
    .map(message =>
      typeof message === 'string'
        ? { role: 'user', parts: [{ type: 'text', content: redactContent(message) }] }
        : { role: roleOf(message?.role), parts: partsOf(message) }
    )
    .filter(message => message.parts.length > 0);
  const json = serializeWithinCap(converted, contentCap(config.events));
  return json ? { 'gen_ai.input.messages': json } : {};
}

/**
 * The `gen_ai.output.messages` attribute for a completion, or nothing when
 * completion capture is off.
 *
 * @param {Object} output
 * @param {string} [output.text] - The answer text
 * @param {Array<Object>} [output.toolCalls] - Tool calls the model made (names only are kept)
 * @param {string} [output.finishReason]
 * @param {Object} config - The telemetry config
 * @returns {Object} `{ 'gen_ai.output.messages': string }` or `{}`
 */
export function outputMessagesAttributes({ text, toolCalls, finishReason } = {}, config) {
  if (!capturesCompletions(config)) return {};
  const message = partsOf({ role: 'assistant', content: text, toolCalls });
  if (message.length === 0) return {};
  const json = serializeWithinCap(
    [
      {
        role: 'assistant',
        parts: message,
        ...(finishReason ? { finish_reason: finishReason } : {})
      }
    ],
    contentCap(config.events)
  );
  return json ? { 'gen_ai.output.messages': json } : {};
}
