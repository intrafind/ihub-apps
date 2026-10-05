/**
 * Signed, machine-readable provenance for exported files (concept §5.3,
 * §8.3; issues #2571, #2576).
 *
 * c2pa-rs cannot yet embed a C2PA manifest into PDF or OOXML, so every export
 * carries an **iHub provenance manifest**: a compact JWS signed with the
 * installation's C2PA signing certificate (x5c chain), with a hard binding to
 * the file so any change is detected. Plus the metadata each format offers:
 *
 * | format            | metadata                                          | signed manifest / binding                         |
 * |-------------------|---------------------------------------------------|---------------------------------------------------|
 * | PDF               | XMP `Iptc4xmpExt:DigitalSourceType`, Info, keywords | JWS in the Info dict, byte-range hash around it  |
 * | DOCX / PPTX / XLSX| `docProps/custom.xml` (`ai:generated`, `ai:provider`, `ai:system`, `ai:manifestId`) | `ihub/provenance.jws` part, hash over all other parts |
 * | HTML              | `<meta>`, JSON-LD                                 | `<script type="application/ihub-provenance+jws">`, hash of the page without it |
 * | Markdown          | YAML front-matter                                 | text signpost (C2PA text wrapper) when enabled    |
 * | TXT / CSV         | label line / `ai_generated` column                | text signpost when enabled                        |
 * | JSON / JSONL      | `aiGenerated`, `provenance` fields                | JWS over the canonical JSON                       |
 *
 * Every export is also recorded server-side (manifest id → file hash), so the
 * detector recognises it even after the embedded manifest was stripped, and
 * the signed manifest is available as a sidecar (`GET /api/exports/manifests/:id`).
 *
 * @module services/provenance/export/ExportSigner
 */
import crypto from 'node:crypto';
import JSZip from 'jszip';
import { inflateBudget, readZipEntry, ZipLimitError, zipEntries } from '../zipLimits.js';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import signingService from '../signing/SigningService.js';
import { canonicalJson, decodeJws } from '../signing/jws.js';
import { applyTextSignpost, extractWrapper, verifyTextSignpost } from '../text/signpost.js';
import { buildXmpPacket } from '../image/imageFormats.js';
import { hashBytes } from '../ProvenanceStore.js';

export const MANIFEST_TYP = 'ihub-export-manifest+jws';
const PDF_MARKER = 'IHUBSIG[';
const OOXML_MANIFEST_PART = 'ihub/provenance.jws';
const OOXML_REL_TYPE = 'https://ihub.intrafind.com/relationships/ai-provenance';
const CUSTOM_PROPS_REL_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties';
const HTML_SCRIPT_OPEN = '<script type="application/ihub-provenance+jws" id="ihub-provenance">';
const HTML_SCRIPT_RE =
  /(<script type="application\/ihub-provenance\+jws" id="ihub-provenance">)([^<]*)(<\/script>)/;
const OOXML_FORMATS = new Set(['docx', 'pptx', 'xlsx']);

// Content hash of a document part (hard binding), not a password.
const sha256Hex = data => crypto.createHash('sha256').update(data).digest('hex'); // lgtm[js/insufficient-password-hash]

/**
 * Whether a relationships part declares a relationship of this type
 * (exact match on the Type attribute, not a substring of the part).
 * @param {string} rels - `_rels/.rels` XML
 * @param {string} type
 * @returns {boolean}
 */
function hasRelationshipType(rels, type) {
  for (const match of rels.matchAll(/\bType="([^"]*)"/g)) {
    if (match[1] === type) return true;
  }
  return false;
}

function xmlEscape(value) {
  return String(value ?? '').replace(
    /[<>&"']/g,
    c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]
  );
}

async function signManifest(payload) {
  const jws = await signingService.signPayload(payload, { typ: MANIFEST_TYP });
  if (!jws) throw new Error('Signing is not available');
  return jws;
}

// ── PDF ─────────────────────────────────────────────────────────────────

async function signPdf(buffer, payload, meta) {
  const doc = await PDFDocument.load(buffer, { updateMetadata: false });
  const xmp = new TextEncoder().encode(
    buildXmpPacket({
      creatorTool: meta.generator,
      description: meta.labelText || 'AI-generated document',
      contentId: payload.manifestId,
      digitalSourceType: payload.digitalSourceType
    })
  );
  const stream = doc.context.stream(xmp, { Type: 'Metadata', Subtype: 'XML', Length: xmp.length });
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(stream));
  doc.setKeywords(['AI-generated', 'iHub Apps', payload.manifestId]);
  doc.setProducer('iHub Apps');
  doc.setCreator(meta.generator);
  // Size the placeholder with a dry run: the hash has a fixed length.
  const dry = await signManifest({
    ...payload,
    binding: { alg: 'sha256', method: 'pdf-placeholder', marker: PDF_MARKER, hash: '0'.repeat(64) }
  });
  const room = dry.length + 256;
  doc
    .getInfoDict()
    .set(PDFName.of('IHubProvenance'), PDFString.of(`${PDF_MARKER}${'0'.repeat(room)}]`));
  const bytes = Buffer.from(await doc.save({ useObjectStreams: false }));
  const text = bytes.toString('latin1');
  const markerAt = text.lastIndexOf(PDF_MARKER);
  if (markerAt === -1) throw new Error('PDF placeholder not found');
  const start = markerAt + PDF_MARKER.length;
  const end = start + room;
  const hash = sha256Hex(Buffer.concat([bytes.subarray(0, start), bytes.subarray(end)]));
  const jws = await signManifest({
    ...payload,
    binding: { alg: 'sha256', method: 'pdf-placeholder', marker: PDF_MARKER, hash }
  });
  if (jws.length > room) throw new Error('Signature does not fit the placeholder');
  bytes.write(jws.padEnd(room, ' '), start, 'latin1');
  return { buffer: bytes, jws };
}

function readPdfManifest(buffer) {
  const text = buffer.toString('latin1');
  const markerAt = text.lastIndexOf(PDF_MARKER);
  if (markerAt === -1) return null;
  const start = markerAt + PDF_MARKER.length;
  const close = text.indexOf(']', start);
  if (close === -1) return null;
  const jws = text.slice(start, close).trim();
  const hash = sha256Hex(Buffer.concat([buffer.subarray(0, start), buffer.subarray(close)]));
  return { jws, computedHash: hash };
}

// ── OOXML ───────────────────────────────────────────────────────────────

/**
 * Hash of every part except the manifest. Inflation is bounded (the archive
 * may be an upload to the detector).
 * @throws {ZipLimitError}
 */
async function partsHash(zip) {
  const entries = zipEntries(zip)
    .filter(entry => entry.name !== OOXML_MANIFEST_PART)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const budget = inflateBudget();
  const h = crypto.createHash('sha256');
  for (const entry of entries) {
    const content = await readZipEntry(entry, budget);
    h.update(`${entry.name}\0${sha256Hex(content)}\n`);
  }
  return h.digest('hex');
}

function customPropsXml(props) {
  const entries = Object.entries(props)
    .map(([name, value], i) => {
      const typed =
        typeof value === 'boolean'
          ? `<vt:bool>${value}</vt:bool>`
          : `<vt:lpwstr>${xmlEscape(String(value).slice(0, 255))}</vt:lpwstr>`;
      return `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="${i + 2}" name="${xmlEscape(name)}">${typed}</property>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">${entries}</Properties>`;
}

async function signOoxml(buffer, payload, meta) {
  const zip = await JSZip.loadAsync(buffer);
  // Custom properties (replaced if the generator wrote any).
  zip.file(
    'docProps/custom.xml',
    customPropsXml({
      'ai:generated': true,
      'ai:system': meta.generator,
      'ai:provider': meta.provider || 'iHub Apps',
      'ai:manifestId': payload.manifestId,
      'ai:digitalSourceType': payload.digitalSourceType,
      ...(payload.signpost ? { 'ai:signpost': payload.signpost } : {})
    })
  );
  let types = await zip.file('[Content_Types].xml').async('string');
  if (!types.includes('PartName="/docProps/custom.xml"')) {
    types = types.replace(
      '</Types>',
      '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/></Types>'
    );
  }
  if (!/Extension="jws"/i.test(types)) {
    types = types.replace(
      '</Types>',
      '<Default Extension="jws" ContentType="application/jose"/></Types>'
    );
  }
  zip.file('[Content_Types].xml', types);
  let rels = await zip.file('_rels/.rels').async('string');
  if (!hasRelationshipType(rels, CUSTOM_PROPS_REL_TYPE)) {
    rels = rels.replace(
      '</Relationships>',
      `<Relationship Id="rIdIhubCustomProps" Type="${CUSTOM_PROPS_REL_TYPE}" Target="docProps/custom.xml"/></Relationships>`
    );
  }
  if (!hasRelationshipType(rels, OOXML_REL_TYPE)) {
    rels = rels.replace(
      '</Relationships>',
      `<Relationship Id="rIdIhubProvenance" Type="${OOXML_REL_TYPE}" Target="${OOXML_MANIFEST_PART}"/></Relationships>`
    );
  }
  zip.file('_rels/.rels', rels);
  const hash = await partsHash(zip);
  const jws = await signManifest({
    ...payload,
    binding: { alg: 'sha256', method: 'ooxml-parts', excluded: [OOXML_MANIFEST_PART], hash }
  });
  zip.file(OOXML_MANIFEST_PART, jws);
  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { buffer: out, jws };
}

async function readOoxmlManifest(buffer) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return null;
  }
  const part = zip.file(OOXML_MANIFEST_PART);
  if (!part) return null;
  try {
    const jws = String(await readZipEntry(part, inflateBudget(), 'utf8')).trim();
    return { jws, computedHash: await partsHash(zip) };
  } catch (error) {
    if (!(error instanceof ZipLimitError)) throw error;
    return { jws: null, error: error.message };
  }
}

// ── HTML ────────────────────────────────────────────────────────────────

async function signHtml(buffer, payload, meta) {
  let html = buffer.toString('utf8');
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CreativeWork',
    name: payload.title,
    dateCreated: payload.createdAt,
    identifier: payload.manifestId,
    creator: { '@type': 'SoftwareApplication', name: meta.generator },
    additionalProperty: [
      { '@type': 'PropertyValue', name: 'digitalSourceType', value: payload.digitalSourceType },
      { '@type': 'PropertyValue', name: 'aiGenerated', value: true }
    ]
  };
  const head = [
    '<meta name="ai-generated" content="true">',
    `<meta name="generator" content="${xmlEscape(meta.generator)}">`,
    `<meta name="ai-provenance-manifest" content="${xmlEscape(payload.manifestId)}">`,
    payload.signpost ? `<link rel="provenance" href="${xmlEscape(payload.signpost)}">` : '',
    `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>`,
    `${HTML_SCRIPT_OPEN}</script>`
  ]
    .filter(Boolean)
    .join('\n');
  html = html.includes('</head>')
    ? html.replace('</head>', () => `${head}\n</head>`) // `head` carries the title: no $-patterns
    : `${head}\n${html}`;
  const hash = sha256Hex(html);
  const jws = await signManifest({
    ...payload,
    binding: { alg: 'sha256', method: 'html-without-manifest', hash }
  });
  const signedHtml = html.replace(
    HTML_SCRIPT_RE,
    (_, open, _old, close) => `${open}${jws}${close}`
  );
  return { buffer: Buffer.from(signedHtml, 'utf8'), jws };
}

function readHtmlManifest(buffer) {
  const html = buffer.toString('utf8');
  const match = html.match(HTML_SCRIPT_RE);
  if (!match) return null;
  return { jws: match[2].trim(), computedHash: sha256Hex(html.replace(HTML_SCRIPT_RE, '$1$3')) };
}

// ── JSON / JSONL ────────────────────────────────────────────────────────

async function signJson(buffer, payload) {
  const doc = JSON.parse(buffer.toString('utf8'));
  const body = { ...doc, aiGenerated: true };
  const hash = sha256Hex(canonicalJson(body));
  const jws = await signManifest({
    ...payload,
    binding: { alg: 'sha256', method: 'json-canonical', hash }
  });
  const out = {
    ...body,
    provenance: { manifestId: payload.manifestId, signpost: payload.signpost, signature: jws }
  };
  return { buffer: Buffer.from(`${JSON.stringify(out, null, 2)}\n`, 'utf8'), jws };
}

function readJsonManifest(buffer) {
  try {
    const doc = JSON.parse(buffer.toString('utf8'));
    const jws = doc?.provenance?.signature;
    if (typeof jws !== 'string') return null;
    const { provenance: _p, ...body } = doc;
    return { jws, computedHash: sha256Hex(canonicalJson(body)) };
  } catch {
    return null;
  }
}

async function signJsonl(buffer, payload) {
  const lines = buffer
    .toString('utf8')
    .split('\n')
    .filter(l => l.trim());
  const hash = sha256Hex(lines.join('\n'));
  const jws = await signManifest({
    ...payload,
    binding: { alg: 'sha256', method: 'jsonl-lines', hash }
  });
  const head = JSON.stringify({
    type: 'provenance',
    aiGenerated: true,
    manifestId: payload.manifestId,
    signpost: payload.signpost,
    signature: jws
  });
  return { buffer: Buffer.from(`${[head, ...lines].join('\n')}\n`, 'utf8'), jws };
}

function readJsonlManifest(buffer) {
  const lines = buffer
    .toString('utf8')
    .split('\n')
    .filter(l => l.trim());
  try {
    const head = JSON.parse(lines[0]);
    if (head?.type !== 'provenance' || typeof head.signature !== 'string') return null;
    return { jws: head.signature, computedHash: sha256Hex(lines.slice(1).join('\n')) };
  } catch {
    return null;
  }
}

// ── Markdown / TXT / CSV ────────────────────────────────────────────────

function frontMatter(payload, meta) {
  return [
    '---',
    'ai_generated: true',
    `generator: "${meta.generator}"`,
    `digital_source_type: "${payload.digitalSourceType}"`,
    `provenance_manifest: "${payload.manifestId}"`,
    ...(payload.signpost ? [`provenance_signpost: "${payload.signpost}"`] : []),
    '---',
    ''
  ].join('\n');
}

async function signText(format, buffer, payload, meta, { signpost }) {
  let text = buffer.toString('utf8');
  if (format === 'markdown') text = `${frontMatter(payload, meta)}\n${text}`;
  if (!signpost) return { buffer: Buffer.from(text, 'utf8'), jws: null };
  if (format === 'csv') {
    // Inside the last quoted cell, so spreadsheet tools see no extra row.
    const lastQuote = text.lastIndexOf('"');
    const withSignpost = await applyTextSignpost(text, {
      contentId: payload.manifestId,
      verification: payload.verification
    });
    const wrapper = withSignpost.slice(text.length);
    const out =
      lastQuote > 0
        ? `${text.slice(0, lastQuote)}${wrapper}${text.slice(lastQuote)}`
        : withSignpost;
    return { buffer: Buffer.from(out, 'utf8'), jws: extractWrapper(out)?.payload.toString('utf8') };
  }
  const out = await applyTextSignpost(text, {
    contentId: payload.manifestId,
    verification: payload.verification
  });
  return {
    buffer: Buffer.from(out, 'utf8'),
    jws: extractWrapper(out)?.payload.toString('utf8') || null
  };
}

// ── API ─────────────────────────────────────────────────────────────────

/**
 * Embed provenance into a rendered export.
 *
 * @param {Object} params
 * @param {string} params.format
 * @param {Buffer} params.buffer
 * @param {Object} params.payload - manifest payload without `binding`
 * @param {{generator: string, provider?: string, labelText?: string}} params.meta
 * @param {boolean} [params.signpost] - text signpost for markdown/txt/csv
 * @returns {Promise<{buffer: Buffer, jws: string|null, fileHash: string}>}
 */
export async function signExport({ format, buffer, payload, meta, signpost = false }) {
  let result;
  if (format === 'pdf') result = await signPdf(buffer, payload, meta);
  else if (OOXML_FORMATS.has(format)) result = await signOoxml(buffer, payload, meta);
  else if (format === 'html') result = await signHtml(buffer, payload, meta);
  else if (format === 'json') result = await signJson(buffer, payload);
  else if (format === 'jsonl') result = await signJsonl(buffer, payload);
  else result = await signText(format, buffer, payload, meta, { signpost });
  return { ...result, fileHash: hashBytes(result.buffer) };
}

/**
 * Find and check the iHub manifest of an exported file.
 *
 * @param {Buffer} buffer
 * @param {{kind: string, trustAnchors?: string[]}} opts - kind from the sniffer (pdf, docx, html, json, text …)
 * @returns {Promise<{found: boolean, method?: string, valid?: boolean, trusted?: boolean, intact?: boolean, payload?: Object, signer?: Object, errors?: string[]}>}
 */
export async function verifyExportManifest(buffer, { kind, trustAnchors = [] }) {
  let read = null;
  if (kind === 'pdf') read = readPdfManifest(buffer);
  else if (OOXML_FORMATS.has(kind)) read = await readOoxmlManifest(buffer);
  else if (kind === 'html') read = readHtmlManifest(buffer);
  else if (kind === 'json') read = readJsonManifest(buffer) || readJsonlManifest(buffer);
  else if (kind === 'text') {
    const text = buffer.toString('utf8');
    const result = await verifyTextSignpost(text, { trustAnchors });
    return result.found ? { found: true, method: 'text-signpost', ...result } : { found: false };
  }
  if (read?.error) {
    // A manifest part is there, but the archive is too large to check.
    return { found: true, valid: false, trusted: false, intact: false, errors: [read.error] };
  }
  if (!read?.jws) return { found: false };
  const decoded = decodeJws(read.jws);
  const verified = await signingService.verifyPayload(read.jws, { extraAnchors: trustAnchors });
  const intact = decoded?.payload?.binding?.hash === read.computedHash;
  return {
    found: true,
    method: decoded?.payload?.binding?.method,
    valid: verified.valid,
    trusted: verified.trusted,
    intact,
    payload: verified.payload,
    signer: verified.signer,
    errors: [...verified.errors, ...(intact ? [] : ['The file was changed after it was signed'])]
  };
}
