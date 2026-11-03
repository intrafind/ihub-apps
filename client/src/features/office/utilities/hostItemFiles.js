// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The open email, the emails the user added, the open meeting and the open web
 * page as chat files.
 *
 * With server-side chat files an Outlook or browser-extension turn does not carry
 * these items as the one-message `hostContext` but as `fileData` entries
 * (`origin: 'email' | 'meeting' | 'page'`). The server stores them with the chat
 * (Files drawer, quotas, retention, sharing, replay), keeps one copy per item
 * (`meta.itemId` / `meta.url`) however many turns resend it, and renders each as
 * the same `<content type="email" origin="open|added">`, `type="meeting"` or
 * `type="page"` block the `hostContext` produces (shared/promptContext.js). The
 * entry's `content` is the text the renderer reads back: header lines, a blank
 * line, the body (`buildHostItemText`).
 *
 * Pure (no Office.js, no DOM): unit-tested under plain node.
 *
 * @module features/office/utilities/hostItemFiles
 */

import { buildHostItemText } from '../../../../../shared/promptContext.js';

/** The server's default per-file cap (`chatFilePolicy` DEFAULT_MAX_FILE_BYTES). */
export const MAX_ORIGINAL_BYTES = 25 * 1024 * 1024;

const MAX_FILE_NAME_BASE = 100;
// The server drops `meta` above 8 KiB (MAX_CHAT_FILE_META_BYTES) — and with it the
// item id the copy is found by — so the entry keeps well below that.
const MAX_META_BYTES = 6 * 1024;
const MAX_META_VALUE = 500;

/**
 * What a storing chat does with the host item.
 *
 * @typedef {Object} HostItemStorage
 * @property {'original_and_text'|'server_text_only'|'client_text_only'} mode
 *   Only `original_and_text` sends originals (real or synthesized `.eml`, attachment
 *   bytes); the other modes send text and nothing else.
 * @property {number} [maxFileBytes] - The per-file cap; default {@link MAX_ORIGINAL_BYTES}.
 */

/** Whether `storage` sends the bytes of originals along with the text. */
export function keepsOriginals(storage) {
  return storage?.mode === 'original_and_text';
}

/** Decoded size of a base64 string, without decoding it. */
export function base64Bytes(base64) {
  if (typeof base64 !== 'string' || !base64) return 0;
  const clean = base64.replaceAll(/\s+/g, '');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

/**
 * The base64 of an original when it may be sent: the mode keeps originals and it
 * fits the per-file cap. `undefined` otherwise, so callers can spread it.
 *
 * @param {string|null|undefined} base64
 * @param {HostItemStorage|null|undefined} storage
 * @returns {string|undefined}
 */
export function originalWithinCap(base64, storage) {
  if (!keepsOriginals(storage) || typeof base64 !== 'string' || !base64) return undefined;
  const cap = Number.isFinite(storage.maxFileBytes) ? storage.maxFileBytes : MAX_ORIGINAL_BYTES;
  return base64Bytes(base64) > cap ? undefined : base64;
}

/**
 * A file name that is safe wherever it ends up (the Files drawer, a download, a
 * zip): no path separators, control characters or characters Windows rejects,
 * no leading/trailing dots or spaces, length-capped, never empty.
 *
 * @param {string|null|undefined} base - Subject, meeting title or page title.
 * @param {string} extension - With the dot (`.eml`).
 * @param {string} fallback - The name (without extension) when `base` leaves nothing.
 * @returns {string}
 */
export function sanitizeItemFileName(base, extension, fallback) {
  const cleaned = String(base ?? '')
    .replaceAll(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]+/g, '') // zero-width, bidi overrides
    .replaceAll(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replaceAll(/[\\/:*?"<>|]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
  const capped = Array.from(trimDotsAndBlanks(cleaned))
    .slice(0, MAX_FILE_NAME_BASE)
    .join('')
    .trim();
  return `${capped || fallback}${extension}`;
}

/** `value` without leading and trailing dots and blanks (linear, no regex backtracking). */
function trimDotsAndBlanks(value) {
  let start = 0;
  let end = value.length;
  while (start < end && (value[start] === '.' || value[start] === ' ')) start += 1;
  while (end > start && (value[end - 1] === '.' || value[end - 1] === ' ')) end -= 1;
  return value.slice(start, end);
}

// 32-bit FNV-1a over UTF-16 code units: enough to tell items of one chat apart.
function hashString(value) {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.codePointAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * A page's identity: its URL without the fragment (`#section` is the same page),
 * with the host in lower case and without a trailing slash on the root.
 *
 * @param {string|null|undefined} url
 * @returns {string} '' when there is no usable URL.
 */
export function normalizeItemUrl(url) {
  const raw = typeof url === 'string' ? url.trim() : '';
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    const out = parsed.toString();
    return parsed.pathname === '/' && !parsed.search ? out.replace(/\/$/, '') : out;
  } catch {
    return raw.replace(/#.*$/, '');
  }
}

/**
 * The id the server finds an item by. Outlook's `item.itemId` when there is one;
 * a draft or an item the host gives no id has none, so a stable one is made from
 * what identifies it.
 *
 * @param {'email'|'meeting'|'page'} kind
 * @param {string|null|undefined} itemId
 * @param {Array<string|null|undefined>} seed - Fields that identify the item.
 * @param {boolean} [isCurrent]
 * @returns {string}
 */
export function stableItemId(kind, itemId, seed, isCurrent = false) {
  if (typeof itemId === 'string' && itemId.trim()) return itemId.trim();
  const basis = [kind, isCurrent ? 'current' : 'added', ...seed.map(v => String(v ?? ''))].join(
    '\u0000'
  );
  return `local:${kind}:${hashString(basis)}`;
}

/** Plain strings only, each value capped, the whole object under the server's meta limit. */
function boundedMeta(meta) {
  const out = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value == null || value === '') continue;
    out[key] =
      typeof value === 'string' && value.length > MAX_META_VALUE
        ? `${value.slice(0, MAX_META_VALUE)}…`
        : value;
  }
  const size = () => new TextEncoder().encode(JSON.stringify(out)).length;
  // Drop the long, display-only fields first; the id and the flags always stay.
  for (const key of ['to', 'cc', 'requiredAttendees', 'optionalAttendees', 'organizer']) {
    if (size() <= MAX_META_BYTES) break;
    delete out[key];
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* RFC 5322 synthesis                                                         */
/* ------------------------------------------------------------------------- */

const CRLF = '\r\n';
const ATOM_TEXT = /^[A-Za-z0-9 !#$%&'*+\-/=?^_`{|}~]+$/;
const ADDRESS = /^[^\s<>@"(),;:\\[\]]+@[^\s<>@"(),;:\\[\]]+$/;

function utf8Base64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCodePoint(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

const singleLine = value =>
  String(value ?? '')
    .split(/[\r\n]/)
    .map(part => part.trim())
    .filter(Boolean)
    .join(' ');
const isPrintableAscii = value => /^[\x20-\x7e]*$/.test(value);

/**
 * RFC 2047 encoded words (`=?UTF-8?B?…?=`) of at most 60 characters each, split on
 * code point boundaries so no character is cut in half.
 */
function encodeWords(text) {
  const words = [];
  let chunk = [];
  let bytes = 0;
  const flush = () => {
    if (chunk.length) words.push(`=?UTF-8?B?${utf8Base64(chunk.join(''))}?=`);
    chunk = [];
    bytes = 0;
  };
  for (const char of text) {
    const size = new TextEncoder().encode(char).length;
    if (bytes + size > 36) flush();
    chunk.push(char);
    bytes += size;
  }
  flush();
  return words.join(' ');
}

/** Unstructured header text (Subject): as is when plain ASCII, encoded words otherwise. */
function encodeUnstructured(value) {
  const text = singleLine(value);
  return isPrintableAscii(text) ? text : encodeWords(text);
}

/** `Name <addr>` with the name as atom, quoted string or encoded words — whichever it needs. */
function formatAddress(person) {
  const email = singleLine(person?.email);
  if (!ADDRESS.test(email)) return '';
  const name = singleLine(person?.name);
  if (!name || name === email) return email;
  let phrase;
  if (!isPrintableAscii(name)) phrase = encodeWords(name);
  else if (ATOM_TEXT.test(name)) phrase = name;
  else phrase = `"${name.replaceAll(/(["\\])/g, '\\$1')}"`;
  return `${phrase} <${email}>`;
}

/** Fold a header at whitespace so no line exceeds 78 characters (RFC 5322 §2.2.3). */
function foldHeader(name, value) {
  const tokens = value.split(' ').filter(Boolean);
  const lines = [];
  let line = `${name}:`;
  for (const token of tokens) {
    if (line.length + 1 + token.length > 76 && line.trim() !== `${name}:`) {
      lines.push(line);
      line = ` ${token}`;
    } else {
      line += ` ${token}`;
    }
  }
  lines.push(line);
  return lines.join(CRLF);
}

function addressHeader(name, people) {
  const formatted = (Array.isArray(people) ? people : people ? [people] : [])
    .map(formatAddress)
    .filter(Boolean);
  return formatted.length ? foldHeader(name, formatted.join(', ')) : '';
}

function rfc5322Date(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toUTCString().replace('GMT', '+0000');
}

/**
 * A minimal RFC 5322 message from what Outlook hands the add-in: headers (From, To,
 * Cc, Date, Subject — RFC 2047 encoded when not ASCII, folded under 78 characters)
 * and the plain-text body (UTF-8, base64, CRLF line ends). Not the original — the
 * HTML, the attachments and the transport headers are not there — but a message any
 * mail client opens.
 *
 * @param {Object} email - The raw item as `readMessageContext` returns it:
 *   `{ subject, from: {name, email}, to: [], cc: [], dateTimeCreated: ISO, bodyText }`.
 * @returns {string|null} The message as base64, or null when there is nothing to put in it.
 */
export function synthesizeEmlBase64(email) {
  if (!email || typeof email !== 'object') return null;
  const body = typeof email.bodyText === 'string' ? email.bodyText.trim() : '';
  if (!body) return null;
  const headers = [
    addressHeader('From', email.from),
    addressHeader('To', email.to),
    addressHeader('Cc', email.cc),
    rfc5322Date(email.dateTimeCreated) ? `Date: ${rfc5322Date(email.dateTimeCreated)}` : '',
    singleLine(email.subject) ? foldHeader('Subject', encodeUnstructured(email.subject)) : '',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'X-iHub-Source: synthesized from the Outlook item'
  ].filter(Boolean);
  const encoded = utf8Base64(body.replaceAll(/\r\n|\r|\n/g, CRLF));
  const lines = encoded.match(/.{1,76}/g) || [];
  const message = `${headers.join(CRLF)}${CRLF}${CRLF}${lines.join(CRLF)}${CRLF}`;
  return btoa(message);
}

/* ------------------------------------------------------------------------- */
/* Entries                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * The `fileData` entry of an email.
 *
 * @param {Object} params
 * @param {Object} params.fields - Display strings as `hostContext` carries them
 *   (`from`, `to`, `cc`, `date`, `subject`, `mailboxUser`, `body`).
 * @param {Object} [params.raw] - The item as Outlook gave it (for the synthesized `.eml`).
 * @param {string|null} [params.itemId]
 * @param {boolean} params.isCurrent - The email the user has open (not an added one).
 * @param {string|null} [params.emlBase64] - The real RFC 5322 message, when Outlook provided it.
 * @param {HostItemStorage} [params.storage]
 * @returns {Object|null}
 */
export function buildEmailFileEntry({ fields, raw, itemId, isCurrent, emlBase64, storage }) {
  const content = buildHostItemText('email', fields);
  if (!content) return null;
  const id = stableItemId('email', itemId, [fields.subject, fields.from, fields.date], isCurrent);
  const original = originalWithinCap(emlBase64 || synthesizeEmlBase64(raw), storage);
  return {
    source: 'local',
    type: 'document',
    origin: 'email',
    fileName: sanitizeItemFileName(fields.subject, '.eml', 'Email'),
    fileType: 'message/rfc822',
    displayType: 'Email',
    content,
    ...(original ? { base64: original } : {}),
    meta: boundedMeta({
      itemId: id,
      from: fields.from,
      to: fields.to,
      cc: fields.cc,
      date: fields.date,
      subject: fields.subject,
      mailboxUser: fields.mailboxUser,
      isCurrent: isCurrent === true
    })
  };
}

/** The `fileData` entry of the open meeting (`<Subject>.ics`, text only). */
export function buildMeetingFileEntry({ fields, itemId }) {
  const content = buildHostItemText('meeting', fields);
  if (!content) return null;
  const id = stableItemId('meeting', itemId, [fields.subject, fields.when, fields.organizer], true);
  return {
    source: 'local',
    type: 'document',
    origin: 'meeting',
    fileName: sanitizeItemFileName(fields.subject, '.ics', 'Meeting'),
    fileType: 'text/calendar',
    displayType: 'Calendar event',
    content,
    meta: boundedMeta({
      itemId: id,
      subject: fields.subject,
      yourRole: fields.yourRole,
      when: fields.when,
      location: fields.location,
      organizer: fields.organizer,
      requiredAttendees: fields.requiredAttendees,
      optionalAttendees: fields.optionalAttendees
    })
  };
}

function hostOfUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** The `fileData` entry of the open web page (`<Title>.md`, text only). */
export function buildPageFileEntry({ fields }) {
  const content = buildHostItemText('page', fields);
  if (!content) return null;
  const url = normalizeItemUrl(fields.url);
  return {
    source: 'local',
    type: 'document',
    origin: 'page',
    fileName: sanitizeItemFileName(fields.title || hostOfUrl(fields.url), '.md', 'Web page'),
    fileType: 'text/markdown',
    displayType: 'Web page',
    content,
    meta: boundedMeta({
      itemId: url || stableItemId('page', null, [fields.title], true),
      url,
      title: fields.title
    })
  };
}

/* ------------------------------------------------------------------------- */
/* Sending an original once                                                   */
/* ------------------------------------------------------------------------- */

function entrySignature(entry) {
  const base64 = entry.base64;
  if (entry.meta?.itemId) {
    // What the server compares to decide that a stored item is unchanged.
    return `item|${entry.meta.itemId}|${entry.meta.isCurrent === true}|${entry.content}`;
  }
  return `file|${entry.fileName}|${base64.length}|${base64.slice(0, 48)}|${base64.slice(-48)}`;
}

/**
 * A chat resends the open email and its attachments with every turn. The server
 * keeps an unchanged email once, so its bytes need not cross the network again;
 * an attachment's bytes are likewise worth sending once per chat. Entries whose
 * original was already sent lose their `base64` (text stays: the prompt needs it).
 *
 * @param {Object[]|null} entries
 * @param {Set<string>} sent - What this chat has sent so far; updated in place.
 * @returns {Object[]|null}
 */
export function omitRepeatedOriginals(entries, sent) {
  if (!Array.isArray(entries)) return entries;
  return entries.map(entry => {
    if (!entry?.base64) return entry;
    const signature = entrySignature(entry);
    if (sent.has(signature)) {
      const { base64: _base64, ...rest } = entry;
      return rest;
    }
    sent.add(signature);
    return entry;
  });
}
