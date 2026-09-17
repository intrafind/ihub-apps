// Best-effort text extraction for the two Outlook attachment formats that
// arrive as textual content rather than a binary document: attached/
// forwarded emails (`format: 'eml'`) and meeting invites
// (`format: 'icalendar'`). Both are plain-text formats (RFC 5322 / RFC
// 5545), so — unlike a real PDF/DOCX — there's no reason to treat them as
// unsupported: we can parse them directly. See issue #1451.
//
// Pure (atob/TextDecoder/regex only, no DOM) so this runs — and is
// unit-tested — under plain node, mirroring `extractMsgContent` in
// fileProcessing.js for the equivalent binary .msg case.

function decodeBase64ToText(base64) {
  if (!base64) return '';
  try {
    const binary = atob(base64.replace(/\s+/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '';
  }
}

function decodeQuotedPrintable(str) {
  return str
    .replace(/=\r?\n/g, '') // soft line break — join wrapped lines
    .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function decodeBodyByEncoding(body, encoding) {
  const enc = (encoding || '').toLowerCase();
  if (enc === 'base64') return decodeBase64ToText(body);
  if (enc === 'quoted-printable') return decodeQuotedPrintable(body);
  return body;
}

// Minimal RFC 2047 encoded-word decoder for headers like
// `=?UTF-8?B?RsO2cnN0ZXI=?=` or `=?UTF-8?Q?F=C3=B6rster?=`.
function decodeMimeWords(str) {
  if (!str) return str;
  return str.replace(/=\?[^?]+\?([BbQq])\?([^?]*)\?=\s*/g, (_m, enc, text) => {
    if (enc.toUpperCase() === 'B') return decodeBase64ToText(text);
    return decodeQuotedPrintable(text.replace(/_/g, ' '));
  });
}

// Regex-only HTML-to-text fallback for eml bodies that only have a
// text/html part. Deliberately simple (no DOMParser) so this module stays
// dependency-free; `htmlToText` in fileProcessing.js is the DOM-based,
// more accurate version used for direct HTML file uploads.
// Named entities this parser understands, decoded in a single regex pass
// below (see the double-unescaping note).
const HTML_ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" };

function stripHtmlToText(html) {
  let text = html;

  // Loop each strip to a fixed point: a single non-recursive pass can
  // leave a live tag behind when the input nests/overlaps delimiters so
  // that removing part of it reassembles one (e.g.
  // "<scr<script>ipt>...</scr</script>ipt>" contains no literal
  // "<script>...</script>" substring, but removing the inner match once
  // leaves "<script>...</script>" behind). Repeating until nothing changes
  // closes that gap.
  let previous;
  do {
    previous = text;
    text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  } while (text !== previous);

  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n');

  do {
    previous = text;
    text = text.replace(/<[^>]*>/g, '');
  } while (text !== previous);

  // Decode all named entities in one pass — resolving each match exactly
  // once — instead of one independent replace per entity. Sequential
  // independent replaces would double-unescape: e.g. text that safely
  // encodes a literal "&lt;" as "&amp;lt;" would, after an `&amp;` -> `&`
  // pass, read as "&lt;" and then get wrongly decoded to "<" by a later
  // pass, turning inert text into a live tag delimiter.
  text = text.replace(
    /&(nbsp|amp|lt|gt|quot|#39|apos);/gi,
    (match, name) => HTML_ENTITIES[name.toLowerCase()] ?? match
  );

  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseContentTypeHeader(value) {
  if (!value) return { type: '', params: {} };
  const parts = value.split(';').map(s => s.trim());
  const type = (parts.shift() || '').toLowerCase();
  const params = {};
  for (const p of parts) {
    const m = p.match(/^([\w-]+)=(.*)$/);
    if (m) params[m[1].toLowerCase()] = m[2].replace(/^"|"$/g, '');
  }
  return { type, params };
}

// Unfolds RFC 5322 header continuation lines (indented lines are part of
// the previous header) and returns a lowercase-keyed map.
function parseEmailHeaders(headerBlock) {
  const unfolded = headerBlock.replace(/\r\n/g, '\n').replace(/\n[ \t]+/g, ' ');
  const headers = {};
  for (const line of unfolded.split('\n')) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) headers[m[1].toLowerCase()] = m[2].trim();
  }
  return headers;
}

// Extracts the readable body from a MIME message part, descending into a
// multipart/* body to find the first text/plain part (preferred) or
// text/html part (converted to text). Non-multipart bodies are decoded
// directly per their own Content-Transfer-Encoding.
function extractBody(rawBody, contentTypeHeader, transferEncoding) {
  const { type, params } = parseContentTypeHeader(contentTypeHeader);

  if (type.startsWith('multipart/') && params.boundary) {
    const segments = rawBody.split(`--${params.boundary}`);
    // First and last segments are the preamble/epilogue, not real parts.
    const parts = segments.slice(1, -1);
    let plainPart = null;
    let htmlPart = null;

    for (const part of parts) {
      const trimmed = part.replace(/^\r?\n/, '');
      const headerEnd = trimmed.search(/\r?\n\r?\n/);
      if (headerEnd === -1) continue;
      const partHeaders = parseEmailHeaders(trimmed.slice(0, headerEnd));
      const partBody = trimmed.slice(headerEnd).replace(/^\r?\n\r?\n/, '');
      const partContentType = partHeaders['content-type'] || '';
      const { type: partType } = parseContentTypeHeader(partContentType);

      if (partType.startsWith('multipart/')) {
        // Nested multipart (e.g. multipart/alternative inside
        // multipart/mixed) — recurse rather than treating it as a leaf.
        const nested = extractBody(
          partBody,
          partContentType,
          partHeaders['content-transfer-encoding']
        );
        if (nested && !plainPart) plainPart = nested;
        continue;
      }

      const decoded = decodeBodyByEncoding(partBody, partHeaders['content-transfer-encoding']);
      if (partType.startsWith('text/plain') && !plainPart) plainPart = decoded.trim();
      else if (partType.startsWith('text/html') && !htmlPart) htmlPart = decoded;
    }

    if (plainPart) return plainPart;
    if (htmlPart) return stripHtmlToText(htmlPart);
    return '';
  }

  const decoded = decodeBodyByEncoding(rawBody, transferEncoding);
  return type.startsWith('text/html') ? stripHtmlToText(decoded) : decoded.trim();
}

/**
 * Parse a base64-encoded attached/forwarded email (`format: 'eml'` from
 * Office's getAttachmentContentAsync) into a readable "headers + body" text
 * block, mirroring `extractMsgContent`'s output shape for .msg files.
 * Returns null if the content can't be decoded/parsed at all.
 */
export function parseEmlAttachment(base64Content) {
  const raw = decodeBase64ToText(base64Content);
  if (!raw) return null;

  const normalized = raw.replace(/\r\n/g, '\n');
  const headerEnd = normalized.indexOf('\n\n');
  if (headerEnd === -1) return null;

  const headers = parseEmailHeaders(normalized.slice(0, headerEnd));
  const bodyText = extractBody(
    normalized.slice(headerEnd + 2),
    headers['content-type'],
    headers['content-transfer-encoding']
  );

  const headerLines = [];
  if (headers.subject) headerLines.push(`Subject: ${decodeMimeWords(headers.subject)}`);
  if (headers.from) headerLines.push(`From: ${decodeMimeWords(headers.from)}`);
  if (headers.to) headerLines.push(`To: ${decodeMimeWords(headers.to)}`);
  if (headers.cc) headerLines.push(`Cc: ${decodeMimeWords(headers.cc)}`);
  if (headers.date) headerLines.push(`Date: ${headers.date}`);

  const result = [headerLines.join('\n'), bodyText].filter(Boolean).join('\n\n').trim();
  return result || null;
}

function unescapeIcsText(value) {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function formatIcsDate(value) {
  // e.g. 20260715T090000Z (date-time) or 20260715 (all-day date).
  const m = value?.match(/^(\d{4})(\d{2})(\d{2})(T(\d{2})(\d{2})(\d{2})Z?)?$/);
  if (!m) return value || '';
  const [, y, mo, d, hasTime, h, mi] = m;
  return hasTime ? `${y}-${mo}-${d} ${h}:${mi}` : `${y}-${mo}-${d}`;
}

function formatIcsParticipant(field) {
  if (!field) return '';
  const cnMatch = field.params.match(/CN=([^;]+)/i);
  const mailtoMatch = field.value.match(/mailto:(.+)$/i);
  const name = cnMatch ? cnMatch[1].replace(/^"|"$/g, '') : '';
  const email = mailtoMatch ? mailtoMatch[1] : field.value;
  if (name && email && name !== email) return `${name} <${email}>`;
  return name || email || '';
}

/**
 * Parse a base64-encoded meeting invite (`format: 'icalendar'` from
 * Office's getAttachmentContentAsync) into a short readable summary
 * (subject, time, location, organizer, description).
 * Returns null if the content can't be decoded/parsed at all.
 */
export function parseIcsAttachment(base64Content) {
  const raw = decodeBase64ToText(base64Content);
  if (!raw) return null;

  // RFC 5545 line folding: a line starting with a space/tab continues the
  // previous line.
  const unfolded = raw.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
  const fields = {};
  for (const line of unfolded.split('\n')) {
    const m = line.match(/^([\w-]+)(;[^:]*)?:(.*)$/);
    if (m) {
      const key = m[1].toUpperCase();
      // First VEVENT wins if the .ics has multiple (rare for a single invite).
      if (!(key in fields)) fields[key] = { params: m[2] || '', value: m[3].trim() };
    }
  }

  const lines = [];
  if (fields.SUMMARY) lines.push(`Meeting: ${unescapeIcsText(fields.SUMMARY.value)}`);
  if (fields.DTSTART) {
    const start = formatIcsDate(fields.DTSTART.value);
    const end = fields.DTEND ? formatIcsDate(fields.DTEND.value) : null;
    lines.push(`When: ${end ? `${start} – ${end}` : start}`);
  }
  if (fields.LOCATION) lines.push(`Location: ${unescapeIcsText(fields.LOCATION.value)}`);
  if (fields.ORGANIZER) lines.push(`Organizer: ${formatIcsParticipant(fields.ORGANIZER)}`);
  if (fields.DESCRIPTION) {
    const description = unescapeIcsText(fields.DESCRIPTION.value).trim();
    if (description) {
      lines.push('');
      lines.push(description);
    }
  }

  const result = lines.join('\n').trim();
  return result || null;
}
