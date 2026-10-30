// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import path from 'node:path';
import zlib from 'node:zlib';
import JSZip from 'jszip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

/**
 * Helpers for Office Open XML packages (Word and PowerPoint files are ZIP
 * archives of XML parts tied together by relationship files and a content
 * type list).
 *
 * The documents engines open an admin's Word or PowerPoint template, add
 * generated parts to it and write it back; this module keeps that package
 * consistent: every part has a content type, every relationship points at a
 * part that exists, and parts nothing refers to any more are removed.
 */

export const NS = Object.freeze({
  rels: 'http://schemas.openxmlformats.org/package/2006/relationships',
  contentTypes: 'http://schemas.openxmlformats.org/package/2006/content-types',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
});

export const REL_TYPES = Object.freeze({
  officeDocument:
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  image: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
  hyperlink: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
  numbering: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering',
  styles: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
  slide: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide',
  slideLayout: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout',
  slideMaster: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster',
  notesSlide: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide',
  notesMaster: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster',
  theme: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme',
  chart: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart',
  package: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/package'
});

/** Limits for a package read from an upload. */
export const PACKAGE_LIMITS = Object.freeze({
  maxEntries: 5000,
  maxUncompressedBytes: 200 * 1024 * 1024,
  maxPartBytes: 100 * 1024 * 1024
});

export class PackageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PackageError';
  }
}

const DEFLATE = '\u0008\u0000';
const STORE = '\u0000\u0000';

/**
 * The bytes of one part, inflated with a hard ceiling: the archive's declared
 * sizes can lie, so the limit applies to the output itself.
 */
function inflatePart(entry, maxBytes) {
  const data = entry._data;
  const magic = data?.compression?.magic;
  const raw = data?.compressedContent;
  if (!raw || (magic !== DEFLATE && magic !== STORE)) {
    throw new PackageError('The Office document uses an unsupported compression.');
  }
  if (magic === STORE) {
    if (raw.length > maxBytes)
      throw new PackageError('A part of the Office document is too large.');
    return Buffer.from(raw);
  }
  try {
    return zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, maxBytes) });
  } catch (error) {
    throw new PackageError(
      error?.code === 'ERR_BUFFER_TOO_LARGE'
        ? 'A part of the Office document is too large when unpacked.'
        : 'A part of the Office document is damaged.'
    );
  }
}

/**
 * Open a ZIP package, refusing archives that would inflate beyond the limits
 * (a "zip bomb"). Every part is inflated here, against a ceiling per part
 * and for the whole package — the sizes an archive declares are not trusted
 * — and kept inflated, so reading it later costs nothing more.
 *
 * @param {Buffer|Uint8Array} bytes
 * @param {Object} [limits]
 * @returns {Promise<JSZip>}
 */
export async function openPackage(bytes, limits = PACKAGE_LIMITS) {
  let source;
  try {
    source = await JSZip.loadAsync(bytes, { checkCRC32: false });
  } catch {
    throw new PackageError('The file is not a valid Office document (not a ZIP archive).');
  }
  const entries = Object.values(source.files);
  if (entries.length > limits.maxEntries) {
    throw new PackageError('The Office document has too many parts.');
  }
  const zip = new JSZip();
  let total = 0;
  for (const entry of entries) {
    if (entry.name.includes('..') || entry.name.startsWith('/')) {
      throw new PackageError('The Office document contains an invalid part name.');
    }
    if (entry.dir) continue;
    const remaining = limits.maxUncompressedBytes - total;
    const data = inflatePart(entry, Math.min(limits.maxPartBytes, remaining));
    total += data.length;
    if (total > limits.maxUncompressedBytes) {
      throw new PackageError('The Office document is too large when unpacked.');
    }
    zip.file(entry.name, data);
  }
  return zip;
}

/**
 * Write a package to a buffer.
 *
 * @param {JSZip} zip
 * @returns {Promise<Buffer>}
 */
export function writePackage(zip) {
  // `[Content_Types].xml` first, as Office writes it; some readers expect it.
  const ordered = new JSZip();
  const types = zip.file('[Content_Types].xml');
  if (types) ordered.file('[Content_Types].xml', types.async('nodebuffer'));
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || entry.name === '[Content_Types].xml') continue;
    ordered.file(entry.name, entry.async('nodebuffer'));
  }
  return ordered.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  });
}

/** Characters XML 1.0 cannot hold (control characters other than tab and newlines). */
export const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

/**
 * Escape text for an XML element or attribute.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function xmlEscape(value) {
  return String(value ?? '')
    .replace(INVALID_XML_CHARS, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/**
 * Parse an XML part. Malformed XML is an error, not a guess.
 *
 * @param {string} xml
 * @param {string} [name] - Part name, for the message.
 * @returns {Document}
 */
export function parseXml(xml, name = 'part') {
  const errors = [];
  const doc = new DOMParser({
    onError: (level, message) => {
      if (level !== 'warning') errors.push(message);
    }
  }).parseFromString(String(xml), 'application/xml');
  if (errors.length || !doc?.documentElement) {
    throw new PackageError(`The Office document has a malformed part (${name}).`);
  }
  return doc;
}

/**
 * Serialize a parsed part, with the XML declaration Office expects.
 *
 * @param {Document} doc
 * @returns {string}
 */
export function serializeXml(doc) {
  const xml = new XMLSerializer().serializeToString(doc).replace(/^<\?xml[^>]*\?>\s*/, '');
  return XML_DECLARATION + xml;
}

/**
 * Read and parse a part, or null when the package has no such part.
 *
 * @param {JSZip} zip
 * @param {string} partPath - Without a leading slash.
 * @returns {Promise<Document|null>}
 */
export async function readXmlPart(zip, partPath) {
  const file = zip.file(partPath);
  if (!file) return null;
  return parseXml(await file.async('string'), partPath);
}

/**
 * Write a parsed part back.
 *
 * @param {JSZip} zip
 * @param {string} partPath
 * @param {Document|string} doc
 */
export function writeXmlPart(zip, partPath, doc) {
  zip.file(partPath, typeof doc === 'string' ? doc : serializeXml(doc));
}

/** Direct children of an element with a given local name. */
export function childElements(parent, localName) {
  const out = [];
  if (!parent) return out;
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 1 && (!localName || node.localName === localName)) out.push(node);
  }
  return out;
}

/** The first direct child with a given local name. */
export function firstChild(parent, localName) {
  return childElements(parent, localName)[0] || null;
}

/**
 * Descendant elements in document order: those with a given local name, or
 * all of them when no name is given.
 */
export function descendants(root, localName) {
  const out = [];
  const walk = node => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType !== 1) continue;
      if (!localName || child.localName === localName) out.push(child);
      walk(child);
    }
  };
  if (root) walk(root);
  return out;
}

/**
 * Parse every XML part of a package: a generated file whose parts do not
 * parse is an error, not a download.
 *
 * @param {JSZip} zip
 */
export async function assertWellFormed(zip) {
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || !/\.(xml|rels)$/i.test(entry.name)) continue;
    parseXml(await entry.async('string'), entry.name);
  }
}

// --- Relationships ----------------------------------------------------------

/**
 * Where a part's relationships are stored: `dir/_rels/name.rels`.
 *
 * @param {string} partPath - e.g. `ppt/slides/slide1.xml`; `''` for the package.
 * @returns {string}
 */
export function relsPathOf(partPath) {
  if (!partPath) return '_rels/.rels';
  const dir = path.posix.dirname(partPath);
  const base = path.posix.basename(partPath);
  return dir === '.' ? `_rels/${base}.rels` : `${dir}/_rels/${base}.rels`;
}

/**
 * The part a relationship file belongs to (`ppt/_rels/presentation.xml.rels`
 * → `ppt/presentation.xml`), or null when the path is not one.
 *
 * @param {string} relsPath
 * @returns {string|null}
 */
export function relsOwnerOf(relsPath) {
  const dir = path.posix.dirname(relsPath);
  const base = path.posix.basename(relsPath);
  if (path.posix.basename(dir) !== '_rels' || !base.endsWith('.rels')) return null;
  const parent = path.posix.dirname(dir);
  const owner = base.slice(0, -'.rels'.length);
  return parent === '.' ? owner : `${parent}/${owner}`;
}

/**
 * Resolve a relationship target to a part path.
 *
 * @param {string} sourcePart - The part owning the relationship.
 * @param {string} target
 * @returns {string} Part path without a leading slash.
 */
export function resolveTarget(sourcePart, target) {
  // Part names in relationships are URIs: `media/image%201.png` names the
  // part `media/image 1.png`.
  let clean = String(target || '').split('#')[0];
  try {
    clean = decodeURI(clean);
  } catch {
    // Not valid percent-encoding: use it as it is.
  }
  if (clean.startsWith('/')) return path.posix.normalize(clean.slice(1));
  const dir = sourcePart ? path.posix.dirname(sourcePart) : '';
  return path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, clean));
}

/**
 * A relationship target relative to its source part.
 *
 * @param {string} sourcePart
 * @param {string} targetPart
 * @returns {string}
 */
export function relativeTarget(sourcePart, targetPart) {
  const dir = path.posix.dirname(sourcePart);
  return path.posix.relative(dir === '.' ? '' : dir, targetPart);
}

/**
 * Read a part's relationships.
 *
 * @param {JSZip} zip
 * @param {string} partPath
 * @returns {Promise<Array<{ id: string, type: string, target: string, external: boolean }>>}
 */
export async function readRels(zip, partPath) {
  const doc = await readXmlPart(zip, relsPathOf(partPath));
  if (!doc) return [];
  return childElements(doc.documentElement, 'Relationship').map(rel => ({
    id: rel.getAttribute('Id'),
    type: rel.getAttribute('Type'),
    target: rel.getAttribute('Target'),
    external: rel.getAttribute('TargetMode') === 'External'
  }));
}

/**
 * Write a part's relationships.
 *
 * @param {JSZip} zip
 * @param {string} partPath
 * @param {Array<{ id: string, type: string, target: string, external?: boolean }>} rels
 */
export function writeRels(zip, partPath, rels) {
  const body = rels
    .map(
      rel =>
        `<Relationship Id="${xmlEscape(rel.id)}" Type="${xmlEscape(rel.type)}" Target="${xmlEscape(rel.target)}"${rel.external ? ' TargetMode="External"' : ''}/>`
    )
    .join('');
  zip.file(
    relsPathOf(partPath),
    `${XML_DECLARATION}<Relationships xmlns="${NS.rels}">${body}</Relationships>`
  );
}

/**
 * A relationship id not yet used in a list.
 *
 * @param {Array<{ id: string }>} rels
 * @returns {string}
 */
export function nextRelId(rels) {
  const used = new Set(rels.map(rel => rel.id));
  let n = rels.length + 1;
  while (used.has(`rId${n}`)) n += 1;
  return `rId${n}`;
}

// --- Content types ----------------------------------------------------------

/**
 * The package's content type list, editable.
 */
export class ContentTypes {
  constructor(doc) {
    this.doc = doc;
    this.root = doc.documentElement;
  }

  static async read(zip) {
    const doc = await readXmlPart(zip, '[Content_Types].xml');
    if (!doc) throw new PackageError('The Office document has no content type list.');
    return new ContentTypes(doc);
  }

  /** The content type of a part (override, else by extension). */
  typeOf(partPath) {
    const name = `/${partPath}`;
    for (const override of childElements(this.root, 'Override')) {
      if (override.getAttribute('PartName')?.toLowerCase() === name.toLowerCase()) {
        return override.getAttribute('ContentType');
      }
    }
    const ext = path.posix.extname(partPath).slice(1).toLowerCase();
    for (const entry of childElements(this.root, 'Default')) {
      if (entry.getAttribute('Extension')?.toLowerCase() === ext) {
        return entry.getAttribute('ContentType');
      }
    }
    return null;
  }

  setOverride(partPath, contentType) {
    this.removeOverride(partPath);
    const node = this.doc.createElementNS(NS.contentTypes, 'Override');
    node.setAttribute('PartName', `/${partPath}`);
    node.setAttribute('ContentType', contentType);
    this.root.appendChild(node);
  }

  removeOverride(partPath) {
    const name = `/${partPath}`.toLowerCase();
    for (const override of childElements(this.root, 'Override')) {
      if (override.getAttribute('PartName')?.toLowerCase() === name) {
        this.root.removeChild(override);
      }
    }
  }

  ensureDefault(extension, contentType) {
    const ext = extension.toLowerCase();
    const exists = childElements(this.root, 'Default').some(
      entry => entry.getAttribute('Extension')?.toLowerCase() === ext
    );
    if (exists) return;
    const node = this.doc.createElementNS(NS.contentTypes, 'Default');
    node.setAttribute('Extension', ext);
    node.setAttribute('ContentType', contentType);
    // Defaults come before overrides.
    const firstOverride = firstChild(this.root, 'Override');
    if (firstOverride) this.root.insertBefore(node, firstOverride);
    else this.root.appendChild(node);
  }

  /** Overrides whose part is not in the package any more. */
  prune(zip) {
    for (const override of childElements(this.root, 'Override')) {
      const name = override.getAttribute('PartName')?.replace(/^\//, '');
      if (name && !zip.file(name)) this.root.removeChild(override);
    }
  }

  write(zip) {
    writeXmlPart(zip, '[Content_Types].xml', this.doc);
  }
}

/** Media types of images the engines embed. */
export const IMAGE_CONTENT_TYPES = Object.freeze({
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg'
});

/**
 * Remove every part no relationship chain from the package root reaches
 * (slides of a template that were replaced, their pictures and charts), and
 * the content type entries of parts that are gone.
 *
 * @param {JSZip} zip
 * @param {ContentTypes} contentTypes
 * @returns {Promise<string[]>} The removed part paths.
 */
export async function removeUnreachableParts(zip, contentTypes) {
  // Part names compare without case (OPC); the archive's entries keep theirs.
  const byName = new Map(
    Object.values(zip.files)
      .filter(entry => !entry.dir)
      .map(entry => [entry.name.toLowerCase(), entry.name])
  );
  const reachable = new Set(['[content_types].xml']);
  const queue = [''];
  while (queue.length) {
    const part = queue.shift();
    const relsPath = byName.get(relsPathOf(part).toLowerCase());
    if (relsPath) reachable.add(relsPath.toLowerCase());
    for (const rel of relsPath ? await readRels(zip, part) : []) {
      if (rel.external) continue;
      const target = byName.get(resolveTarget(part, rel.target).toLowerCase());
      if (!target || reachable.has(target.toLowerCase())) continue;
      reachable.add(target.toLowerCase());
      queue.push(target);
    }
  }
  const removed = [];
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || reachable.has(entry.name.toLowerCase())) continue;
    // A relationship file belongs to its part: kept while the part is.
    const owner = relsOwnerOf(entry.name);
    if (owner !== null && reachable.has(owner.toLowerCase())) continue;
    zip.remove(entry.name);
    removed.push(entry.name);
  }
  contentTypes.prune(zip);
  return removed;
}

const CORE_PROPERTIES_REL =
  'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties';
const CORE_PROPERTIES_TYPE = 'application/vnd.openxmlformats-package.core-properties+xml';

/**
 * Set the core properties (title, author, dates) of a package, adding the
 * part when the package has none.
 *
 * @param {JSZip} zip
 * @param {ContentTypes} contentTypes
 * @param {{ title?: string, author?: string, subject?: string, language?: string }} props
 */
export async function setCoreProperties(zip, contentTypes, props = {}) {
  const rels = await readRels(zip, '');
  let rel = rels.find(r => r.type === CORE_PROPERTIES_REL);
  if (!rel) {
    rel = { id: nextRelId(rels), type: CORE_PROPERTIES_REL, target: 'docProps/core.xml' };
    rels.push(rel);
    writeRels(zip, '', rels);
  }
  const partPath = resolveTarget('', rel.target);
  writeCoreProperties(zip, props, partPath);
  contentTypes.setOverride(partPath, CORE_PROPERTIES_TYPE);
}

function writeCoreProperties(zip, { title, author, subject, language } = {}, partPath) {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const field = (tag, value) => (value ? `<${tag}>${xmlEscape(value)}</${tag}>` : '');
  zip.file(
    partPath,
    `${XML_DECLARATION}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${field('dc:title', title)}${field('dc:subject', subject)}${field('dc:creator', author || 'iHub Apps')}<cp:lastModifiedBy>iHub Apps</cp:lastModifiedBy>${field('dc:language', language)}<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`
  );
}
