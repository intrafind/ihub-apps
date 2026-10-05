/**
 * Plain-text and Markdown export renderers.
 *
 * Message content is written verbatim (it already is markdown), so any text
 * watermark the model embedded survives the export. The AI label goes at
 * the top; front matter and provenance fields are added later by
 * `ExportSigner`.
 *
 * - TXT follows the former browser export (`exportToTXT`): title, "=" rules,
 *   `[Role] - time` headers, settings at the end.
 * - Markdown: the label as a blockquote, then either the transcript
 *   ("## User", "## Assistant") or, for one-document sources, the document
 *   body as written.
 *
 * @module services/provenance/export/renderers/text
 */
import {
  formatDateTime,
  getDocumentMarker,
  getVerificationMarker,
  isTranscript,
  prepareCommon,
  roleLabel
} from './common.js';

const RULE = '='.repeat(50);
const THIN_RULE = '-'.repeat(50);

/** Collapse whitespace so a value fits on one heading/meta line. */
const oneLine = value =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Render the export as plain text.
 *
 * @param {Object} doc - normalised export document (see `renderExport`)
 * @returns {Promise<Buffer>} UTF-8 text
 */
export async function renderTxt(doc) {
  const { t, label, settingsRows, exportedOn } = prepareCommon(doc);
  const lines = [];
  if (label.show) {
    lines.push(label.text, ...label.details, RULE, '');
  }
  lines.push(oneLine(doc.title), RULE, '');
  lines.push(`${t('export.header.app')}: ${oneLine(doc.appName)}`, exportedOn, '', RULE, '');

  const transcript = isTranscript(doc);
  for (const message of doc.messages) {
    const meta = [formatDateTime(message.timestamp, doc.language), message.model]
      .filter(Boolean)
      .join(' · ');
    const marker = transcript
      ? getVerificationMarker(message, t)
      : getDocumentMarker(doc, message, t);
    if (transcript) {
      let header = `[${roleLabel(message.role, t)}]`;
      if (meta) header += ` - ${meta}`;
      if (marker) header += ` (${marker.text})`;
      lines.push(header, THIN_RULE);
    } else if (meta || marker) {
      lines.push([meta, marker ? `(${marker.text})` : ''].filter(Boolean).join(' '), THIN_RULE);
    }
    lines.push(message.content, '');
  }

  if (settingsRows.length > 0) {
    lines.push(RULE, t('export.settings.title'), RULE, '');
    for (const [name, value] of settingsRows) lines.push(`${name}: ${value}`);
  }
  return Buffer.from(`${lines.join('\n').replace(/\n+$/, '')}\n`, 'utf8');
}

/**
 * The label as a markdown blockquote (one paragraph per line).
 * @param {Object} label - see `getLabelInfo`
 * @returns {string[]} markdown lines
 */
function labelBlockquote(label) {
  if (!label.show) return [];
  const out = [`> **${oneLine(label.text)}**`];
  for (const detail of label.details) out.push('>', `> ${oneLine(detail)}`);
  out.push('');
  return out;
}

/**
 * Render the export as Markdown.
 *
 * @param {Object} doc - normalised export document (see `renderExport`)
 * @returns {Promise<Buffer>} UTF-8 markdown
 */
export async function renderMarkdown(doc) {
  const { t, label, settingsRows, exportedOn } = prepareCommon(doc);
  const lines = [...labelBlockquote(label)];

  if (isTranscript(doc)) {
    lines.push(`# ${oneLine(doc.title)}`, '', `*${oneLine(doc.appName)} · ${exportedOn}*`, '');
    for (const message of doc.messages) {
      const heading = [
        roleLabel(message.role, t),
        formatDateTime(message.timestamp, doc.language),
        message.model ? oneLine(message.model) : ''
      ]
        .filter(Boolean)
        .join(' · ');
      lines.push('---', '', `## ${heading}`, '');
      const marker = getVerificationMarker(message, t);
      if (marker) lines.push(`*${marker.text}*`, '');
      lines.push(message.content, '');
    }
  } else {
    doc.messages.forEach((message, index) => {
      if (index > 0) lines.push('---', '');
      const marker = getDocumentMarker(doc, message, t);
      if (marker) lines.push(`*${marker.text}*`, '');
      lines.push(message.content, '');
    });
  }

  if (settingsRows.length > 0) {
    lines.push('---', '', `## ${t('export.settings.title')}`, '');
    for (const [name, value] of settingsRows) lines.push(`- **${name}:** ${oneLine(value)}`);
  }
  return Buffer.from(`${lines.join('\n').replace(/\n+$/, '')}\n`, 'utf8');
}
