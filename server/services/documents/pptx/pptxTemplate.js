// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import {
  REL_TYPES,
  childElements,
  descendants,
  firstChild,
  openPackage,
  readRels,
  readXmlPart,
  resolveTarget
} from '../ooxml/opcPackage.js';

/**
 * Read a PowerPoint template: its slide size, theme, masters and layouts with
 * their placeholders, and which layout serves which kind of slide.
 *
 * Positions a layout leaves to its master are resolved from the master, so
 * every placeholder has a rectangle. Layout kinds come from the layout's
 * type (`title`, `secHead`, `obj`, `twoObj`, `titleOnly`, `blank`), else from
 * its placeholders, else from its name; an admin can name the layout for a
 * kind in the document template (`pptx.layouts`).
 */

const PRESENTATION = 'ppt/presentation.xml';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** Placeholder types that hold a slide's main content. */
const CONTENT_TYPES = new Set(['obj', 'body', 'tbl', 'chart', 'pic', 'dgm', 'media', 'clipArt']);

const KIND_BY_TYPE = {
  title: 'title',
  secHead: 'section',
  obj: 'content',
  tx: 'content',
  twoObj: 'twoColumn',
  twoTxTwoObj: 'twoColumn',
  twoColTx: 'twoColumn',
  objTx: 'content',
  titleOnly: 'titleOnly',
  blank: 'blank'
};

const NAME_HINTS = [
  ['title', /title slide|titelfolie|titel-folie|diapositive de titre|cover|deckblatt/i],
  ['section', /section|abschnitt|kapitel|chapter|divider|trenn/i],
  ['twoColumn', /two|zwei|2 /i],
  ['titleOnly', /title only|nur titel|titre seul/i],
  ['blank', /blank|leer|vide/i],
  ['content', /content|inhalt|text|contenu/i]
];

function attr(element, name) {
  const value = element?.getAttribute(name);
  return value === null || value === undefined || value === '' ? undefined : value;
}

function rectOf(spPr) {
  const xfrm = firstChild(spPr, 'xfrm');
  const off = firstChild(xfrm, 'off');
  const ext = firstChild(xfrm, 'ext');
  if (!off || !ext) return null;
  const rect = {
    x: Number(off.getAttribute('x')),
    y: Number(off.getAttribute('y')),
    cx: Number(ext.getAttribute('cx')),
    cy: Number(ext.getAttribute('cy'))
  };
  return Object.values(rect).every(Number.isFinite) && rect.cx > 0 && rect.cy > 0 ? rect : null;
}

/** First `a:defRPr@sz` (hundredths of a point) under a list style level. */
function levelSize(listStyle, level = 1) {
  const lvl = firstChild(listStyle, `lvl${level}pPr`);
  const size = Number(firstChild(lvl, 'defRPr')?.getAttribute('sz'));
  return Number.isFinite(size) && size > 0 ? size : undefined;
}

/**
 * The placeholders of a master or layout.
 *
 * @param {Document} doc
 * @returns {Array<{ type: string, idx?: string, name: string, rect: Object|null, size?: number, orient?: string }>}
 */
function placeholdersOf(doc) {
  const tree = firstChild(firstChild(doc.documentElement, 'cSld'), 'spTree');
  const out = [];
  for (const sp of descendants(tree, 'sp')) {
    const ph = descendants(firstChild(sp, 'nvSpPr'), 'ph')[0];
    if (!ph) continue;
    out.push({
      type: attr(ph, 'type') || 'obj',
      idx: attr(ph, 'idx'),
      orient: attr(ph, 'orient'),
      name: attr(descendants(firstChild(sp, 'nvSpPr'), 'cNvPr')[0], 'name') || '',
      rect: rectOf(firstChild(sp, 'spPr')),
      size: levelSize(firstChild(firstChild(sp, 'txBody'), 'lstStyle'))
    });
  }
  return out;
}

/** The master placeholder a layout placeholder inherits from. */
function masterPlaceholderFor(master, ph) {
  const kind =
    ph.type === 'ctrTitle' || ph.type === 'title'
      ? 'title'
      : ['dt', 'ftr', 'sldNum'].includes(ph.type)
        ? ph.type
        : 'body';
  return master.placeholders.find(p => p.type === kind) || null;
}

function themeOf(doc) {
  const colors = {};
  const scheme = descendants(doc?.documentElement, 'clrScheme')[0];
  for (const child of childElements(scheme)) {
    const color =
      firstChild(child, 'srgbClr')?.getAttribute('val') ||
      firstChild(child, 'sysClr')?.getAttribute('lastClr');
    if (color) colors[child.localName] = color.toUpperCase();
  }
  const fonts = {};
  for (const [key, tag] of [
    ['major', 'majorFont'],
    ['minor', 'minorFont']
  ]) {
    const typeface = firstChild(descendants(doc?.documentElement, tag)[0], 'latin')?.getAttribute(
      'typeface'
    );
    if (typeface) fonts[key] = typeface;
  }
  return { colors, fonts };
}

function bodySizes(masterDoc) {
  const styles = descendants(masterDoc.documentElement, 'bodyStyle')[0];
  return Array.from(
    { length: 9 },
    (_, i) => levelSize(styles, i + 1) || [2000, 1800, 1600][i] || 1400
  );
}

function titleSize(masterDoc) {
  return levelSize(descendants(masterDoc.documentElement, 'titleStyle')[0]) || 3200;
}

/**
 * Open and read a template.
 *
 * @param {Buffer|Uint8Array} buffer
 * @returns {Promise<Object>} `{ zip, slideSize, masters, layouts, slideIds,
 *   notesMaster }` — the package is ready to be filled.
 */
export async function loadPresentationTemplate(buffer) {
  const zip = await openPackage(buffer);
  const presentation = await readXmlPart(zip, PRESENTATION);
  if (!presentation) throw new Error('The file has no presentation part.');
  const presRels = await readRels(zip, PRESENTATION);
  const relTarget = id => {
    const rel = presRels.find(r => r.id === id);
    return rel ? resolveTarget(PRESENTATION, rel.target) : null;
  };
  const size = firstChild(presentation.documentElement, 'sldSz');
  const slideSize = {
    cx: Number(size?.getAttribute('cx')) || 12192000,
    cy: Number(size?.getAttribute('cy')) || 6858000
  };
  const masters = [];
  const layouts = [];
  const masterIds = descendants(presentation.documentElement, 'sldMasterId');
  for (const masterId of masterIds) {
    const path = relTarget(masterId.getAttributeNS(NS_R, 'id') || masterId.getAttribute('r:id'));
    const doc = path ? await readXmlPart(zip, path) : null;
    if (!doc) continue;
    const rels = await readRels(zip, path);
    const themeRel = rels.find(r => r.type === REL_TYPES.theme);
    const master = {
      path,
      placeholders: placeholdersOf(doc),
      theme: themeRel
        ? themeOf(await readXmlPart(zip, resolveTarget(path, themeRel.target)))
        : themeOf(null),
      bodySizes: bodySizes(doc),
      titleSize: titleSize(doc)
    };
    masters.push(master);
    for (const layoutId of descendants(doc.documentElement, 'sldLayoutId')) {
      const relId = layoutId.getAttributeNS(NS_R, 'id') || layoutId.getAttribute('r:id');
      const rel = rels.find(r => r.id === relId);
      if (!rel) continue;
      const layoutPath = resolveTarget(path, rel.target);
      const layoutDoc = await readXmlPart(zip, layoutPath);
      if (!layoutDoc) continue;
      const placeholders = placeholdersOf(layoutDoc).map(ph => {
        const inherited = masterPlaceholderFor(master, ph);
        return {
          ...ph,
          rect: ph.rect || inherited?.rect || null,
          size: ph.size || inherited?.size
        };
      });
      layouts.push({
        path: layoutPath,
        master,
        name: attr(firstChild(layoutDoc.documentElement, 'cSld'), 'name') || '',
        type: attr(layoutDoc.documentElement, 'type') || 'cust',
        placeholders
      });
    }
  }
  if (!layouts.length) throw new Error('The template has no slide layouts.');
  const notesRel = presRels.find(r => r.type === REL_TYPES.notesMaster);
  return {
    zip,
    presentation,
    presRels,
    slideSize,
    masters,
    layouts,
    notesMaster: notesRel ? resolveTarget(PRESENTATION, notesRel.target) : null
  };
}

function contentPlaceholders(layout) {
  return layout.placeholders.filter(ph => CONTENT_TYPES.has(ph.type) && ph.rect);
}

function titlePlaceholder(layout) {
  return layout.placeholders.find(ph => ph.type === 'title' || ph.type === 'ctrTitle') || null;
}

/** What a layout's placeholders say it is for. */
function kindFromPlaceholders(layout) {
  const title = titlePlaceholder(layout);
  const contents = contentPlaceholders(layout);
  if (title?.type === 'ctrTitle') return 'title';
  if (layout.placeholders.some(ph => ph.type === 'subTitle')) return 'title';
  if (title && contents.length === 1) return 'content';
  if (title && contents.length === 2) return 'twoColumn';
  if (title && contents.length === 0) return 'titleOnly';
  if (!title && contents.length === 0) return 'blank';
  return null;
}

function kindFromName(layout) {
  for (const [kind, pattern] of NAME_HINTS) if (pattern.test(layout.name)) return kind;
  return null;
}

/**
 * The layout for each kind of slide, with fallbacks.
 *
 * @param {Array} layouts - From {@link loadPresentationTemplate}.
 * @param {Object} [overrides] - Layout names by kind (`pptx.layouts`).
 * @returns {Object<string, Object>} Kind → layout.
 */
export function chooseLayouts(layouts, overrides = {}) {
  const chosen = {};
  for (const [kind, name] of Object.entries(overrides || {})) {
    const layout = layouts.find(l => l.name.toLowerCase() === String(name).toLowerCase());
    if (layout) chosen[kind] = layout;
  }
  const candidates = kind => [
    ...layouts.filter(l => KIND_BY_TYPE[l.type] === kind),
    ...layouts.filter(l => KIND_BY_TYPE[l.type] === undefined && kindFromPlaceholders(l) === kind),
    ...layouts.filter(l => kindFromName(l) === kind)
  ];
  for (const kind of ['title', 'section', 'content', 'twoColumn', 'titleOnly', 'blank']) {
    if (chosen[kind]) continue;
    const [first] = candidates(kind).filter(
      l => kind !== 'content' || contentPlaceholders(l).length
    );
    if (first) chosen[kind] = first;
  }
  chosen.content ||= layouts.find(l => contentPlaceholders(l).length) || layouts[0];
  chosen.title ||= chosen.content;
  chosen.section ||= chosen.title;
  chosen.titleOnly ||= chosen.content;
  chosen.twoColumn ||= chosen.content;
  chosen.blank ||= chosen.titleOnly;
  return chosen;
}

export { contentPlaceholders, titlePlaceholder };

/**
 * What a PowerPoint template offers, for the admin page: its layouts and the
 * one chosen for each kind of slide.
 *
 * @param {Buffer} buffer
 * @param {Object} [overrides]
 * @returns {Promise<Object>}
 */
export async function analyzePowerpointTemplate(buffer, overrides) {
  const template = await loadPresentationTemplate(buffer);
  const chosen = chooseLayouts(template.layouts, overrides);
  const ratio = template.slideSize.cx / template.slideSize.cy;
  const theme = template.masters[0]?.theme || { colors: {}, fonts: {} };
  return {
    slideSize: {
      width: Math.round((template.slideSize.cx / 914400) * 100) / 100,
      height: Math.round((template.slideSize.cy / 914400) * 100) / 100,
      aspectRatio:
        Math.abs(ratio - 16 / 9) < 0.02
          ? '16:9'
          : Math.abs(ratio - 4 / 3) < 0.02
            ? '4:3'
            : ratio.toFixed(2)
    },
    layouts: template.layouts.map(layout => ({
      name: layout.name,
      type: layout.type,
      placeholders: layout.placeholders.map(ph => ph.type)
    })),
    mapping: Object.fromEntries(
      Object.entries(chosen).map(([kind, layout]) => [kind, layout.name])
    ),
    theme: { colors: theme.colors, fonts: theme.fonts },
    hasNotesMaster: Boolean(template.notesMaster)
  };
}
