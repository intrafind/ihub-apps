// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import path from 'node:path';
import {
  ContentTypes,
  IMAGE_CONTENT_TYPES,
  NS,
  REL_TYPES,
  childElements,
  descendants,
  firstChild,
  nextRelId,
  openPackage,
  readRels,
  readXmlPart,
  relativeTarget,
  removeUnreachableParts,
  resolveTarget,
  setCoreProperties,
  writePackage,
  writeRels,
  writeXmlPart
} from '../ooxml/opcPackage.js';

/**
 * Put a generated Word document into a company's Word template.
 *
 * The template (`.docx` or `.dotx`) brings the corporate design: its styles,
 * headers and footers (letterhead, logo, page numbers), page setup, theme
 * and any fixed text such as a cover page. The generated document brings the
 * content. The merge:
 *
 * - places the content at a paragraph that holds only `{{content}}`;
 *   without one, after the template's own text, or — when the template body
 *   is empty — as the whole body. The template's section settings (page
 *   size, margins, header and footer references) are kept;
 * - maps every style the content uses to the template's style with the same
 *   built-in name (`heading 1`, `Title`, `List Paragraph`, `Quote`, …), so a
 *   template in any language styles the content; styles the template does
 *   not have are copied over;
 * - merges list numbering, pictures and hyperlinks under new ids;
 * - fills `{{title}}`, `{{subtitle}}`, `{{author}}`, `{{date}}` and
 *   `{{company}}` in the body, headers and footers, also when Word split the
 *   placeholder into several runs;
 * - turns a template (`.dotx`) into a document, sets the document
 *   properties, and drops parts nothing refers to any more.
 */

const WORD_DOCUMENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const NUMBERING_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml';
const STYLES_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml';
const HEADER_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/header';
const FOOTER_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer';
const SETTINGS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const WP_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';

export const TEXT_PLACEHOLDERS = Object.freeze(['title', 'subtitle', 'author', 'date', 'company']);
const PLACEHOLDER = /\{\{\s*([a-z]+)\s*\}\}/gi;

/** Settings elements that come after `w:updateFields` (schema order). */
const AFTER_UPDATE_FIELDS = new Set([
  'hdrShapeDefaults',
  'footnotePr',
  'endnotePr',
  'compat',
  'docVars',
  'rsids',
  'mathPr',
  'attachedSchema',
  'themeFontLang',
  'clrSchemeMapping',
  'doNotIncludeSubdocsInStats',
  'doNotAutoCompressPictures',
  'forceUpgrade',
  'captions',
  'readModeInkLockDown',
  'smartTagType',
  'schemaLibrary',
  'shapeDefaults',
  'doNotEmbedSmartTags',
  'decimalSymbol',
  'listSeparator'
]);

function wAttr(element, name) {
  return element?.getAttributeNS(NS.w, name) ?? element?.getAttribute(`w:${name}`) ?? null;
}

function setWAttr(element, name, value) {
  element.setAttributeNS(NS.w, `w:${name}`, String(value));
}

async function mainPartOf(zip) {
  const rel = (await readRels(zip, '')).find(r => r.type === REL_TYPES.officeDocument);
  return rel ? resolveTarget('', rel.target) : 'word/document.xml';
}

/** The text of a paragraph, from its `w:t` elements. */
function paragraphText(paragraph) {
  return descendants(paragraph, 't')
    .filter(t => t.namespaceURI === NS.w)
    .map(t => t.textContent)
    .join('');
}

/**
 * Replace `{{name}}` placeholders in one paragraph, across runs.
 *
 * @returns {boolean} Whether anything was replaced.
 */
function replaceInParagraph(paragraph, values) {
  const texts = descendants(paragraph, 't').filter(t => t.namespaceURI === NS.w);
  if (!texts.length) return false;
  let changed = false;
  for (;;) {
    const full = texts.map(t => t.textContent).join('');
    const match = [...full.matchAll(PLACEHOLDER)].find(m =>
      Object.hasOwn(values, m[1].toLowerCase())
    );
    if (!match) return changed;
    const start = match.index;
    const end = start + match[0].length;
    const value = String(values[match[1].toLowerCase()] ?? '');
    let offset = 0;
    let first = true;
    for (const t of texts) {
      const text = t.textContent;
      const s = offset;
      const e = offset + text.length;
      offset = e;
      if (e <= start || s >= end) continue;
      const localStart = Math.max(0, start - s);
      const localEnd = Math.min(text.length, end - s);
      t.textContent = text.slice(0, localStart) + (first ? value : '') + text.slice(localEnd);
      t.setAttributeNS(XML_NS, 'xml:space', 'preserve');
      first = false;
    }
    changed = true;
  }
}

function replacePlaceholders(root, values) {
  for (const paragraph of descendants(root, 'p')) {
    if (paragraph.namespaceURI === NS.w) replaceInParagraph(paragraph, values);
  }
}

function placeholdersIn(root) {
  const found = new Set();
  for (const paragraph of descendants(root, 'p')) {
    for (const match of paragraphText(paragraph).matchAll(PLACEHOLDER)) {
      found.add(match[1].toLowerCase());
    }
  }
  return found;
}

async function headerFooterParts(zip, mainPart) {
  return (await readRels(zip, mainPart))
    .filter(rel => !rel.external && (rel.type === HEADER_REL || rel.type === FOOTER_REL))
    .map(rel => resolveTarget(mainPart, rel.target));
}

function bodyOf(doc) {
  return firstChild(doc.documentElement, 'body');
}

function lastSectPr(body) {
  const last = childElements(body).at(-1);
  return last?.localName === 'sectPr' ? last : null;
}

/** Whether the template body holds anything but empty paragraphs. */
function hasContent(body) {
  for (const child of childElements(body)) {
    if (child.localName === 'sectPr') continue;
    if (child.localName !== 'p') return true;
    if (paragraphText(child).trim()) return true;
    if (descendants(child, 'drawing').length || descendants(child, 'pict').length) return true;
  }
  return false;
}

function twipsAttr(element, name, fallback) {
  const value = Number(wAttr(element, name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Page setup of a template's last section, in twips.
 */
function pageSetupOf(doc) {
  const sectPr = lastSectPr(bodyOf(doc));
  const size = firstChild(sectPr, 'pgSz');
  const margin = firstChild(sectPr, 'pgMar');
  const width = twipsAttr(size, 'w', 11906);
  const height = twipsAttr(size, 'h', 16838);
  const margins = {
    left: twipsAttr(margin, 'left', 1417),
    top: twipsAttr(margin, 'top', 1417),
    right: twipsAttr(margin, 'right', 1417),
    bottom: twipsAttr(margin, 'bottom', 1134)
  };
  return {
    width,
    height,
    landscape: wAttr(size, 'orient') === 'landscape' || width > height,
    margins,
    contentWidth: Math.max(2000, width - margins.left - margins.right),
    contentHeight: Math.max(2000, height - margins.top - margins.bottom)
  };
}

async function stylesOf(zip, mainPart) {
  const rel = (await readRels(zip, mainPart)).find(r => r.type === REL_TYPES.styles);
  if (!rel) return null;
  const partPath = resolveTarget(mainPart, rel.target);
  const doc = await readXmlPart(zip, partPath);
  return doc ? { partPath, doc } : null;
}

function styleIndex(stylesDoc) {
  const byId = new Map();
  const byName = new Map();
  for (const style of childElements(stylesDoc.documentElement, 'style')) {
    const id = wAttr(style, 'styleId');
    const name = wAttr(firstChild(style, 'name'), 'val');
    if (!id) continue;
    byId.set(id, style);
    if (name) byName.set(`${wAttr(style, 'type')}:${name.toLowerCase()}`, id);
  }
  return { byId, byName };
}

/**
 * What a Word template offers, for the admin page.
 *
 * @param {Buffer} buffer
 * @returns {Promise<Object>}
 */
export async function inspectWordTemplate(buffer) {
  const zip = await openPackage(buffer);
  const mainPart = await mainPartOf(zip);
  const doc = await readXmlPart(zip, mainPart);
  const placeholders = placeholdersIn(doc);
  for (const part of await headerFooterParts(zip, mainPart)) {
    const partDoc = await readXmlPart(zip, part);
    for (const name of placeholdersIn(partDoc)) placeholders.add(name);
  }
  const styles = await stylesOf(zip, mainPart);
  const index = styles ? styleIndex(styles.doc) : { byName: new Map() };
  const has = name => index.byName.has(`paragraph:${name}`);
  const setup = pageSetupOf(doc);
  return {
    placeholders: [...placeholders].sort(),
    contentPlaceholder: placeholders.has('content'),
    bodyHasContent: hasContent(bodyOf(doc)),
    headerFooterParts: (await headerFooterParts(zip, mainPart)).length,
    page: {
      width: Math.round(setup.width / 20),
      height: Math.round(setup.height / 20),
      landscape: setup.landscape
    },
    styles: {
      title: has('title'),
      headings: [1, 2, 3].every(level => has(`heading ${level}`)),
      listParagraph: has('list paragraph'),
      quote: has('quote')
    }
  };
}

/** The first accent colour of the template's theme, as hex without `#`. */
async function themeAccentOf(zip, mainPart) {
  const rel = (await readRels(zip, mainPart)).find(r => r.type === REL_TYPES.theme);
  if (!rel) return null;
  const theme = await readXmlPart(zip, resolveTarget(mainPart, rel.target));
  const accent = descendants(theme?.documentElement, 'accent1')[0];
  const color = firstChild(accent, 'srgbClr')?.getAttribute('val');
  return /^[0-9a-f]{6}$/i.test(color || '') ? color.toUpperCase() : null;
}

/**
 * Page setup, placeholders and accent colour of a template, before the
 * content is built.
 *
 * @param {Buffer} buffer
 * @returns {Promise<{ setup: Object, placeholders: Set<string>, accent: string|null }>}
 */
export async function readWordTemplateLayout(buffer) {
  const zip = await openPackage(buffer);
  const mainPart = await mainPartOf(zip);
  const doc = await readXmlPart(zip, mainPart);
  return {
    setup: pageSetupOf(doc),
    placeholders: placeholdersIn(bodyOf(doc)),
    accent: await themeAccentOf(zip, mainPart)
  };
}

/** Styles drawn like headings: copied ones take the template's theme look. */
const HEADING_LIKE = /^(heading [1-9]|title|toc heading)$/i;

/**
 * Make a copied heading-like style follow the template's theme: its heading
 * font (`majorHAnsi`) and accent colour, as Word's own built-in headings do,
 * instead of iHub's default font and colour.
 */
function followTemplateTheme(style, name, accent) {
  if (!HEADING_LIKE.test(name || '')) return;
  const rPr = firstChild(style, 'rPr');
  const fonts = firstChild(rPr, 'rFonts');
  if (fonts) {
    for (const attr of ['ascii', 'hAnsi', 'eastAsia', 'cs']) fonts.removeAttributeNS(NS.w, attr);
    setWAttr(fonts, 'asciiTheme', 'majorHAnsi');
    setWAttr(fonts, 'hAnsiTheme', 'majorHAnsi');
    setWAttr(fonts, 'eastAsiaTheme', 'majorEastAsia');
    setWAttr(fonts, 'cstheme', 'majorBidi');
  }
  const color = firstChild(rPr, 'color');
  if (color) {
    setWAttr(color, 'val', accent || '1F3864');
    setWAttr(color, 'themeColor', 'accent1');
  }
}

/**
 * Map the generated document's styles onto the template's, copying the ones
 * the template lacks.
 */
function styleMapper(generated, template, templateDoc, accent) {
  const gen = styleIndex(generated);
  const tpl = styleIndex(template);
  const mapped = new Map();
  const root = template.documentElement;
  const map = id => {
    if (!id) return id;
    if (mapped.has(id)) return mapped.get(id);
    const source = gen.byId.get(id);
    if (!source) {
      mapped.set(id, id);
      return id;
    }
    const type = wAttr(source, 'type');
    const name = wAttr(firstChild(source, 'name'), 'val');
    const existing = name ? tpl.byName.get(`${type}:${name.toLowerCase()}`) : null;
    if (existing) {
      mapped.set(id, existing);
      return existing;
    }
    let newId = id;
    for (let n = 2; tpl.byId.has(newId); n += 1) newId = `${id}Ihub${n}`;
    mapped.set(id, newId);
    const copy = templateDoc.importNode(source, true);
    setWAttr(copy, 'styleId', newId);
    copy.removeAttributeNS(NS.w, 'default');
    followTemplateTheme(copy, name, accent);
    for (const ref of ['basedOn', 'next', 'link']) {
      const node = firstChild(copy, ref);
      if (node) setWAttr(node, 'val', map(wAttr(node, 'val')));
    }
    tpl.byId.set(newId, copy);
    root.appendChild(copy);
    return newId;
  };
  return map;
}

function maxIdOf(elements, attribute) {
  let max = 0;
  for (const element of elements) {
    const value = Number(wAttr(element, attribute));
    if (Number.isFinite(value) && value > max) max = value;
  }
  return max;
}

/**
 * Merge the generated numbering definitions into the template's.
 *
 * @returns {Promise<Map<string, string>>} Generated numId → template numId.
 */
async function mergeNumbering(ctx) {
  const map = new Map();
  const genRel = ctx.genRels.find(r => r.type === REL_TYPES.numbering);
  if (!genRel) return map;
  const genDoc = await readXmlPart(ctx.gen, resolveTarget(ctx.genMain, genRel.target));
  if (!genDoc) return map;
  const tplRel = ctx.tplRels.find(r => r.type === REL_TYPES.numbering);
  if (!tplRel) {
    const partPath = 'word/numbering.xml';
    writeXmlPart(ctx.tpl, partPath, genDoc);
    ctx.tplRels.push({
      id: nextRelId(ctx.tplRels),
      type: REL_TYPES.numbering,
      target: relativeTarget(ctx.tplMain, partPath)
    });
    ctx.types.setOverride(partPath, NUMBERING_TYPE);
    return map;
  }
  const partPath = resolveTarget(ctx.tplMain, tplRel.target);
  const tplDoc = await readXmlPart(ctx.tpl, partPath);
  const tplRoot = tplDoc.documentElement;
  const absOffset = maxIdOf(childElements(tplRoot, 'abstractNum'), 'abstractNumId') + 1;
  const numOffset = maxIdOf(childElements(tplRoot, 'num'), 'numId') + 1;
  const firstNum = firstChild(tplRoot, 'num');
  for (const abstractNum of childElements(genDoc.documentElement, 'abstractNum')) {
    const copy = tplDoc.importNode(abstractNum, true);
    setWAttr(copy, 'abstractNumId', Number(wAttr(abstractNum, 'abstractNumId')) + absOffset);
    if (firstNum) tplRoot.insertBefore(copy, firstNum);
    else tplRoot.appendChild(copy);
  }
  const lastNum = childElements(tplRoot, 'num').at(-1);
  let anchor = lastNum ? lastNum.nextSibling : null;
  for (const num of childElements(genDoc.documentElement, 'num')) {
    const copy = tplDoc.importNode(num, true);
    const newId = Number(wAttr(num, 'numId')) + numOffset;
    map.set(wAttr(num, 'numId'), String(newId));
    setWAttr(copy, 'numId', newId);
    const abstractRef = firstChild(copy, 'abstractNumId');
    if (abstractRef) setWAttr(abstractRef, 'val', Number(wAttr(abstractRef, 'val')) + absOffset);
    if (anchor) tplRoot.insertBefore(copy, anchor);
    else tplRoot.appendChild(copy);
    anchor = copy.nextSibling;
  }
  writeXmlPart(ctx.tpl, partPath, tplDoc);
  return map;
}

/**
 * Carry relationships the content refers to (pictures, hyperlinks) over to
 * the template's document part.
 */
async function remapRelationships(ctx, nodes) {
  const map = new Map();
  let mediaCount = 0;
  const remap = async oldId => {
    if (map.has(oldId)) return map.get(oldId);
    const rel = ctx.genRels.find(r => r.id === oldId);
    if (!rel) return oldId;
    const id = nextRelId(ctx.tplRels);
    if (rel.external) {
      ctx.tplRels.push({ id, type: rel.type, target: rel.target, external: true });
    } else {
      const source = resolveTarget(ctx.genMain, rel.target);
      const file = ctx.gen.file(source);
      if (!file) return oldId;
      const ext = path.posix.extname(source).slice(1).toLowerCase();
      let target;
      do {
        mediaCount += 1;
        target = `word/media/ihub-${mediaCount}.${ext}`;
      } while (ctx.tpl.file(target));
      ctx.tpl.file(target, await file.async('nodebuffer'));
      if (IMAGE_CONTENT_TYPES[ext]) ctx.types.ensureDefault(ext, IMAGE_CONTENT_TYPES[ext]);
      ctx.tplRels.push({ id, type: rel.type, target: relativeTarget(ctx.tplMain, target) });
    }
    map.set(oldId, id);
    return id;
  };
  for (const node of nodes) {
    for (const element of [node, ...descendants(node)]) {
      for (const attribute of Array.from(element.attributes || [])) {
        if (attribute.namespaceURI === NS.r) {
          attribute.value = await remap(attribute.value);
        }
      }
    }
  }
}

async function enableFieldUpdate(ctx) {
  const rel = ctx.tplRels.find(r => r.type === SETTINGS_REL);
  if (!rel) return;
  const partPath = resolveTarget(ctx.tplMain, rel.target);
  const doc = await readXmlPart(ctx.tpl, partPath);
  if (!doc) return;
  const root = doc.documentElement;
  if (firstChild(root, 'updateFields')) return;
  const element = doc.createElementNS(NS.w, 'w:updateFields');
  setWAttr(element, 'val', 'true');
  const before = childElements(root).find(child => AFTER_UPDATE_FIELDS.has(child.localName));
  if (before) root.insertBefore(element, before);
  else root.appendChild(element);
  writeXmlPart(ctx.tpl, partPath, doc);
}

/**
 * Merge a generated document into a Word template.
 *
 * @param {Buffer} generated - From `buildDocx(spec, { forTemplate: true })`.
 * @param {Buffer} template - The `.docx`/`.dotx` template.
 * @param {Object} options
 * @param {Object} options.values - Placeholder values (`title`, `subtitle`, …).
 * @param {boolean} [options.updateFields] - Ask Word to update fields (the
 *   table of contents) when the document is opened.
 * @param {Object} [options.properties] - Core properties (`title`, `author`, …).
 * @param {string} [options.accent] - The template theme's accent colour (hex,
 *   no `#`), for styles copied into it.
 * @returns {Promise<Buffer>}
 */
export async function mergeIntoWordTemplate(generated, template, options = {}) {
  const gen = await openPackage(generated);
  const tpl = await openPackage(template);
  const genMain = await mainPartOf(gen);
  const tplMain = await mainPartOf(tpl);
  const ctx = {
    gen,
    tpl,
    genMain,
    tplMain,
    genRels: await readRels(gen, genMain),
    tplRels: await readRels(tpl, tplMain),
    types: await ContentTypes.read(tpl)
  };
  ctx.types.setOverride(tplMain, WORD_DOCUMENT_TYPE);

  const genDoc = await readXmlPart(gen, genMain);
  const tplDoc = await readXmlPart(tpl, tplMain);
  const tplBody = bodyOf(tplDoc);
  const nodes = childElements(bodyOf(genDoc))
    .filter(node => node.localName !== 'sectPr')
    .map(node => tplDoc.importNode(node, true));
  if (nodes.at(-1)?.localName === 'tbl') {
    nodes.push(tplDoc.createElementNS(NS.w, 'w:p'));
  }

  // Styles: the template's, plus the ones only the content has.
  const genStyles = await stylesOf(gen, genMain);
  let tplStyles = await stylesOf(tpl, tplMain);
  if (!tplStyles && genStyles) {
    const partPath = 'word/styles.xml';
    writeXmlPart(tpl, partPath, genStyles.doc);
    ctx.tplRels.push({
      id: nextRelId(ctx.tplRels),
      type: REL_TYPES.styles,
      target: relativeTarget(tplMain, partPath)
    });
    ctx.types.setOverride(partPath, STYLES_TYPE);
    tplStyles = { partPath, doc: await readXmlPart(tpl, partPath) };
  }
  if (genStyles && tplStyles) {
    const map = styleMapper(genStyles.doc, tplStyles.doc, tplStyles.doc, options.accent);
    for (const node of nodes) {
      for (const element of [node, ...descendants(node)]) {
        if (['pStyle', 'rStyle', 'tblStyle'].includes(element.localName)) {
          setWAttr(element, 'val', map(wAttr(element, 'val')));
        }
      }
    }
    writeXmlPart(tpl, tplStyles.partPath, tplStyles.doc);
  }

  const numbering = await mergeNumbering(ctx);
  await remapRelationships(ctx, nodes);

  let drawingId = 5000;
  const bookmarkOffset = 10000;
  for (const node of nodes) {
    for (const element of [node, ...descendants(node)]) {
      if (element.localName === 'numId' && numbering.has(wAttr(element, 'val'))) {
        setWAttr(element, 'val', numbering.get(wAttr(element, 'val')));
      } else if (element.localName === 'docPr' && element.namespaceURI === WP_NS) {
        drawingId += 1;
        element.setAttribute('id', String(drawingId));
      } else if (element.localName === 'bookmarkStart' || element.localName === 'bookmarkEnd') {
        setWAttr(element, 'id', Number(wAttr(element, 'id')) + bookmarkOffset);
      }
    }
  }

  // Place the content.
  const marker = descendants(tplBody, 'p').find(
    p => p.namespaceURI === NS.w && paragraphText(p).trim().toLowerCase() === '{{content}}'
  );
  const sectPr = lastSectPr(tplBody);
  if (marker) {
    for (const node of nodes) marker.parentNode.insertBefore(node, marker);
    marker.parentNode.removeChild(marker);
  } else {
    if (!hasContent(tplBody)) {
      for (const child of childElements(tplBody)) {
        if (child !== sectPr) tplBody.removeChild(child);
      }
    }
    for (const node of nodes) {
      if (sectPr) tplBody.insertBefore(node, sectPr);
      else tplBody.appendChild(node);
    }
  }

  const values = options.values || {};
  replacePlaceholders(tplBody, values);
  writeXmlPart(tpl, tplMain, tplDoc);
  for (const part of await headerFooterParts(tpl, tplMain)) {
    const partDoc = await readXmlPart(tpl, part);
    if (!partDoc) continue;
    replacePlaceholders(partDoc.documentElement, values);
    writeXmlPart(tpl, part, partDoc);
  }

  if (options.updateFields) await enableFieldUpdate(ctx);
  writeRels(tpl, tplMain, ctx.tplRels);
  await setCoreProperties(tpl, ctx.types, options.properties || {});
  await removeUnreachableParts(tpl, ctx.types);
  ctx.types.write(tpl);
  return writePackage(tpl);
}
