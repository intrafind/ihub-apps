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
 *
 * A layout can also carry **text slots**: small text placeholders next to its
 * title that a slide fills besides its title and content — a label above the
 * title (`kicker`), an introduction under it (`lead`), the presenter on a title
 * slide. A slot is an ordinary body placeholder that the document template
 * names in `pptx.slots` (by the placeholder's name in the layout), or that
 * follows a naming convention (`Kicker`/`Eyebrow`, `Lead`/`Einleitung`). Slots
 * are not content areas. The layout of a slide with slots is the one of its
 * kind that has the most of them.
 */

const PRESENTATION = 'ppt/presentation.xml';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** Placeholder types that hold a slide's main content. */
const CONTENT_TYPES = new Set(['obj', 'body', 'tbl', 'chart', 'pic', 'dgm', 'media', 'clipArt']);

/**
 * Slots a template gets without declaring them, found by the placeholder's
 * name in the layout, with what happens to their text when a layout has no
 * such placeholder (`drop`, or `text`: it becomes a paragraph of the slide).
 */
export const CONVENTIONAL_SLOTS = Object.freeze({
  kicker: {
    pattern: /kicker|eyebrow/i,
    ifMissing: 'drop',
    description: {
      en: 'A short label above the slide title, for example the chapter or topic.',
      de: 'Ein kurzes Label über dem Folientitel, zum Beispiel Kapitel oder Thema.'
    }
  },
  lead: {
    pattern: /\blead\b|einleitung|teaser/i,
    ifMissing: 'text',
    description: {
      en: 'One sentence under the title that gives the context of the slide.',
      de: 'Ein Satz unter dem Titel, der den Zusammenhang der Folie beschreibt.'
    }
  }
});

/** Placeholder types a slot can be (a text placeholder). */
const SLOT_PLACEHOLDER_TYPES = new Set(['body', 'obj', 'tx']);

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
 * The slots to look for in a template: the ones the document template
 * declares (placeholder name, compared without case), and the conventional
 * ones unless the template declares a slot of that id itself.
 *
 * @param {Object<string, { placeholder: string }>} [declared] - `pptx.slots`.
 * @returns {Array<{ id: string, explicit: boolean, matches: (name: string) => boolean }>}
 */
function slotMatchers(declared = {}) {
  const matchers = Object.entries(declared || {}).map(([id, slot]) => {
    const wanted = String(slot.placeholder || '')
      .trim()
      .toLowerCase();
    return {
      id,
      explicit: true,
      matches: name => wanted !== '' && name.trim().toLowerCase() === wanted
    };
  });
  for (const [id, { pattern }] of Object.entries(CONVENTIONAL_SLOTS)) {
    if (declared?.[id]) continue;
    matchers.push({ id, explicit: false, matches: name => pattern.test(name) });
  }
  return matchers;
}

/** The slot a placeholder is, by its name, or undefined. */
function slotOf(type, name, matchers) {
  for (const matcher of matchers) {
    // A conventional name only counts on a body placeholder; a declared one on any text placeholder.
    const typeFits = matcher.explicit ? SLOT_PLACEHOLDER_TYPES.has(type) : type === 'body';
    if (typeFits && matcher.matches(name)) return matcher.id;
  }
  return undefined;
}

/**
 * The placeholders of a master or layout.
 *
 * @param {Document} doc
 * @param {Array} [matchers] - From {@link slotMatchers}.
 * @returns {Array<{ type: string, idx?: string, name: string, slot?: string, text: string, rect: Object|null, size?: number, orient?: string }>}
 */
function placeholdersOf(doc, matchers = []) {
  const tree = firstChild(firstChild(doc.documentElement, 'cSld'), 'spTree');
  const out = [];
  for (const sp of descendants(tree, 'sp')) {
    const ph = descendants(firstChild(sp, 'nvSpPr'), 'ph')[0];
    if (!ph) continue;
    const type = attr(ph, 'type') || 'obj';
    const name = attr(descendants(firstChild(sp, 'nvSpPr'), 'cNvPr')[0], 'name') || '';
    out.push({
      type,
      idx: attr(ph, 'idx'),
      orient: attr(ph, 'orient'),
      name,
      slot: slotOf(type, name, matchers),
      // The text the layout shows in it: a footer placeholder can carry a default.
      text: descendants(firstChild(sp, 'txBody'), 't')
        .map(t => t.textContent)
        .join('')
        .trim(),
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
 * @param {Object} [options]
 * @param {Object<string, { placeholder: string }>} [options.slots] - The slots the
 *   document template declares (`pptx.slots`).
 * @returns {Promise<Object>} `{ zip, slideSize, masters, layouts, slideIds,
 *   notesMaster }` — the package is ready to be filled.
 */
export async function loadPresentationTemplate(buffer, { slots } = {}) {
  const matchers = slotMatchers(slots);
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
      placeholders: placeholdersOf(doc, matchers),
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
      const placeholders = placeholdersOf(layoutDoc, matchers).map(ph => {
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
  return layout.placeholders.filter(ph => CONTENT_TYPES.has(ph.type) && ph.rect && !ph.slot);
}

/** The ids of the text slots a layout has. */
export function layoutSlotIds(layout) {
  return [...new Set(layout.placeholders.filter(ph => ph.slot && ph.rect).map(ph => ph.slot))];
}

/** The layout's placeholder for a slot, or null. */
export function slotPlaceholder(layout, id) {
  return layout.placeholders.find(ph => ph.slot === id && ph.rect) || null;
}

/** Whether a layout has any text slot. */
export function hasTextSlots(layout) {
  return layoutSlotIds(layout).length > 0;
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
 * The kind of slide a layout serves (`title`, `section`, `content`,
 * `twoColumn`, `titleOnly`, `blank`), or null when it cannot be told.
 *
 * @param {Object} layout - From {@link loadPresentationTemplate}.
 * @returns {string|null}
 */
export function layoutKind(layout) {
  const byType = KIND_BY_TYPE[layout.type];
  if (byType) return byType;
  return kindFromPlaceholders(layout) || kindFromName(layout);
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
  // A layout with a kicker or lead placeholder is for the slides that have one:
  // the plain layouts of a kind come first.
  const candidates = kind => {
    const all = [
      ...layouts.filter(l => KIND_BY_TYPE[l.type] === kind),
      ...layouts.filter(
        l => KIND_BY_TYPE[l.type] === undefined && kindFromPlaceholders(l) === kind
      ),
      ...layouts.filter(l => kindFromName(l) === kind)
    ];
    return [...all.filter(l => !hasTextSlots(l)), ...all.filter(hasTextSlots)];
  };
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

/**
 * The layout for a slide that fills text slots: of the layouts of its kind,
 * the one that has the most of the slots, then the fewest others. The layout
 * chosen for the kind (`base`) wins a tie, and stays when no layout has any.
 *
 * @param {Array} layouts - From {@link loadPresentationTemplate}.
 * @param {string} kind - The slide's kind.
 * @param {Object} base - The layout chosen for the kind.
 * @param {string[]} slotIds - The slots the slide fills.
 * @returns {Object} A layout.
 */
export function chooseLayoutForSlots(layouts, kind, base, slotIds) {
  if (!slotIds.length) return base;
  const candidates = [base, ...layouts.filter(l => l !== base && layoutKind(l) === kind)];
  let best = null;
  for (const layout of candidates) {
    const ids = layoutSlotIds(layout);
    const covered = slotIds.filter(id => ids.includes(id)).length;
    const extra = ids.length - covered;
    if (!best || covered > best.covered || (covered === best.covered && extra < best.extra)) {
      best = { layout, covered, extra };
    }
  }
  return best.covered > 0 ? best.layout : base;
}

export { contentPlaceholders, titlePlaceholder };

/** Where a placeholder is, in words a model understands: relative to the title, else on a 3 × 3 grid. */
function positionOf(rect, title, size) {
  if (title && rect !== title) {
    if (rect.y + rect.cy <= title.y + title.cy / 2) return 'above-title';
    if (rect.y >= title.y + title.cy * 0.75 && rect.y + rect.cy / 2 < size.cy * 0.4) {
      return 'below-title';
    }
  }
  const cx = rect.x + rect.cx / 2;
  const cy = rect.y + rect.cy / 2;
  const vertical = cy < size.cy / 3 ? 'top' : cy > (size.cy * 2) / 3 ? 'bottom' : 'middle';
  const horizontal = cx < size.cx / 3 ? 'left' : cx > (size.cx * 2) / 3 ? 'right' : 'centre';
  return `${vertical}-${horizontal}`;
}

/**
 * How much text fits a box, as an estimate: lines of the font size and
 * characters per line (bold and capital text is wider than average).
 */
function capacityOf(rect, hundredths) {
  const points = (hundredths || 1800) / 100;
  const lines = Math.max(1, Math.floor(rect.cy / (points * 1.2 * 12700)));
  const perLine = Math.max(1, Math.floor(rect.cx / (points * 0.55 * 12700)));
  return { lines, chars: Math.floor((lines * perLine) / 5) * 5 };
}

const FOOTER_ROLES = { ftr: 'footer', dt: 'date', sldNum: 'slideNumber' };

/** The placeholders of a layout, described for the admin page and for the model. */
function describeLayout(layout, template) {
  const master = layout.master || template.masters[0];
  const title = titlePlaceholder(layout)?.rect || null;
  const inches = value => Math.round((value / 914400) * 100) / 100;
  return layout.placeholders
    .filter(ph => ph.rect)
    .map(ph => {
      let role = FOOTER_ROLES[ph.type] || 'other';
      if (ph.type === 'title' || ph.type === 'ctrTitle') role = 'title';
      else if (ph.type === 'subTitle') role = 'subtitle';
      else if (ph.slot) role = 'slot';
      else if (CONTENT_TYPES.has(ph.type)) role = 'content';
      const textual = role === 'slot' || role === 'content' || role === 'subtitle';
      return {
        role,
        ...(ph.slot ? { slot: ph.slot } : {}),
        name: ph.name,
        type: ph.type,
        ...(ph.text && role === 'footer' ? { text: ph.text } : {}),
        ...(ph.text && (role === 'slot' || role === 'content') ? { prompt: ph.text } : {}),
        position: positionOf(ph.rect, title, template.slideSize),
        left: inches(ph.rect.x),
        top: inches(ph.rect.y),
        width: inches(ph.rect.cx),
        height: inches(ph.rect.cy),
        ...(textual
          ? { capacity: capacityOf(ph.rect, ph.size || (master?.bodySizes || [])[0]) }
          : {})
      };
    });
}

/** The slots of a template: the declared ones and the ones layouts have by convention. */
function summarizeSlots(layouts, declared = {}) {
  const found = new Map();
  for (const layout of layouts) {
    for (const id of layoutSlotIds(layout)) {
      const entry = found.get(id) || [];
      entry.push({ name: layout.name, kind: layoutKind(layout) });
      found.set(id, entry);
    }
  }
  const ids = new Set([...Object.keys(declared || {}), ...found.keys()]);
  return [...ids].map(id => {
    const config = declared?.[id];
    const conventional = CONVENTIONAL_SLOTS[id];
    return {
      id,
      source: config ? 'config' : 'convention',
      placeholder: config?.placeholder || null,
      description: config?.description || conventional?.description || {},
      ifMissing: config?.ifMissing || conventional?.ifMissing || 'drop',
      layouts: found.get(id) || []
    };
  });
}

/**
 * Words PowerPoint puts into the names of placeholders nobody named: a name
 * made of these says nothing about what belongs in the placeholder.
 */
const GENERIC_NAME_WORDS = new Set([
  'content',
  'text',
  'body',
  'object',
  'inhalt',
  'inhalts',
  'objekt',
  'contenu',
  'texte',
  'platzhalter',
  'placeholder',
  'textplatzhalter',
  'inhaltsplatzhalter',
  'objektplatzhalter',
  'textfeld',
  'espace',
  'reserve',
  'left',
  'right',
  'links',
  'rechts',
  'top',
  'bottom',
  'oben',
  'unten',
  'de',
  'du',
  'and',
  'und'
]);

function isGenericName(name) {
  const words = String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return words.every(word => GENERIC_NAME_WORDS.has(word));
}

/** A slot id from a placeholder name: "Kicker (Label above the title)" → `kicker`, "Referent/in" → `referentIn`. */
function slotIdFromName(name) {
  const words = String(name || '')
    .replace(/\s*[([].*$/, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const id = words
    .map((word, i) =>
      i ? word[0].toUpperCase() + word.slice(1).toLowerCase() : word.toLowerCase()
    )
    .join('');
  const clean = /^[a-z]/.test(id) ? id : `slot${id}`;
  return clean.slice(0, 32);
}

/** The tallest a text placeholder is to count as a slot rather than a content area (inches). */
const SLOT_MAX_HEIGHT = 1.3;

/**
 * Text placeholders that look like slots a template author meant, though no
 * slot is declared for them: named by hand (not "Content Placeholder 3"),
 * small (a label or a sentence, not a content area) and not the subtitle of a
 * title or section slide. Suggestions only: the admin decides which become
 * slots.
 *
 * @param {Array} layouts - Described layouts (`kind`, `name`, `elements`).
 * @param {Set<string>} taken - Slot ids already in use.
 * @returns {Array<{ id: string, placeholder: string, prompt: string, position: string, capacity: Object, layouts: Array<{ name: string, kind: string }> }>}
 */
function suggestSlots(layouts, taken) {
  const byName = new Map();
  for (const layout of layouts) {
    const texts = layout.elements.filter(
      e => e.role === 'content' && ['body', 'obj', 'tx'].includes(e.type)
    );
    // On a title or section slide the text placeholder under the title is its subtitle.
    const headline = layout.kind === 'title' || layout.kind === 'section';
    const hasSubtitle = layout.elements.some(e => e.role === 'subtitle');
    const subtitle =
      headline && !hasSubtitle
        ? [...texts].sort((a, b) => a.left - b.left || a.top - b.top)[0]
        : null;
    for (const element of texts) {
      if (element === subtitle || element.height > SLOT_MAX_HEIGHT) continue;
      if (!element.name || isGenericName(element.name)) continue;
      const key = element.name.trim().toLowerCase();
      const entry = byName.get(key) || { element, layouts: [] };
      entry.layouts.push({ name: layout.name, kind: layout.kind });
      byName.set(key, entry);
    }
  }
  const used = new Set(taken);
  return [...byName.values()].map(({ element, layouts: where }) => {
    const base = slotIdFromName(element.name) || 'slot';
    let id = base;
    for (let n = 2; used.has(id); n += 1) id = `${base.slice(0, 29)}${n}`;
    used.add(id);
    return {
      id,
      placeholder: element.name,
      prompt: element.prompt || '',
      position: element.position,
      capacity: element.capacity,
      layouts: where
    };
  });
}

/**
 * What a PowerPoint template offers, for the admin page and for the model:
 * its layouts, the one chosen for each kind of slide, and its text slots.
 *
 * @param {Buffer} buffer
 * @param {Object} [overrides]
 * @param {Object} [options]
 * @param {Object} [options.slots] - The slots the document template declares (`pptx.slots`).
 * @returns {Promise<Object>}
 */
export async function analyzePowerpointTemplate(buffer, overrides, { slots } = {}) {
  const template = await loadPresentationTemplate(buffer, { slots });
  const chosen = chooseLayouts(template.layouts, overrides);
  const ratio = template.slideSize.cx / template.slideSize.cy;
  const theme = template.masters[0]?.theme || { colors: {}, fonts: {} };
  const layouts = template.layouts.map(layout => ({
    name: layout.name,
    type: layout.type,
    kind: layoutKind(layout),
    placeholders: layout.placeholders.map(ph => ph.type),
    elements: describeLayout(layout, template)
  }));
  const slotSummary = summarizeSlots(template.layouts, slots);
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
    layouts,
    mapping: Object.fromEntries(
      Object.entries(chosen).map(([kind, layout]) => [kind, layout.name])
    ),
    slots: slotSummary,
    // Placeholders that look like slots but are not declared: for the admin to adopt.
    suggestedSlots: suggestSlots(
      layouts,
      new Set([...slotSummary.map(slot => slot.id), ...Object.keys(CONVENTIONAL_SLOTS)])
    ),
    theme: { colors: theme.colors, fonts: theme.fonts },
    hasNotesMaster: Boolean(template.notesMaster)
  };
}
