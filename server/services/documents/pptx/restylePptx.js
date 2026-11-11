// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import {
  ContentTypes,
  NS,
  REL_TYPES,
  childElements,
  descendants,
  firstChild,
  nextRelId,
  parseXml,
  readRels,
  readXmlPart,
  relativeTarget,
  removeUnreachableParts,
  resolveTarget,
  serializeXml,
  setCoreProperties,
  writePackage,
  writeRels,
  writeXmlPart,
  xmlEscape
} from '../ooxml/opcPackage.js';
import {
  contentArea,
  ensureNotesMaster,
  PRESENTATION_TYPE,
  insertPresentationChild,
  removeTemplateSlides,
  uniquePath
} from './buildPptx.js';
import {
  chooseLayouts,
  contentPlaceholders,
  layoutKind,
  loadPresentationTemplate
} from './pptxTemplate.js';
import { PML_NAMESPACES, XML_HEAD } from './pptxXml.js';

/**
 * Move a presentation onto a PowerPoint template: the deck's slides are
 * imported into the template's package (its master, layouts and theme), so
 * the deck looks like the company's own.
 *
 * - **Layout.** Each slide gets the template's layout for its kind (`title`,
 *   `section`, `content`, `twoColumn`, `titleOnly`, `blank`), judged from the
 *   layout it had.
 * - **Titles, subtitles, footers** take the template's placeholders and
 *   therefore its positions, fonts and colours.
 * - **Body text alone on a slide** takes the template's content placeholder.
 * - **Everything else** (pictures, charts, tables, text boxes, groups, and
 *   body text next to them) keeps its arrangement: the shapes are scaled
 *   together, by one factor, into the template's content area.
 * - **Carried over:** pictures, charts with their data, tables, speaker notes,
 *   links, transitions. **Dropped:** slide backgrounds (the template has its
 *   own), the old master, layouts and theme.
 *
 * Formatting a shape carries itself (an explicit colour or font on a run)
 * stays; what came from the old master or theme follows the template.
 */

const PRESENTATION = 'ppt/presentation.xml';
const SLIDE_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
const NOTES_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml';

const TITLE_TYPES = new Set(['title', 'ctrTitle']);
const FOOTER_TYPES = new Set(['ftr', 'dt', 'sldNum']);
const TEXT_PLACEHOLDER_TYPES = new Set([undefined, 'body', 'obj', 'tx']);
const GROUP_PROPERTIES = new Set(['nvGrpSpPr', 'grpSpPr', 'extLst']);
/** Relationships a copied part must not follow: structure the template provides. */
const STRUCTURAL_RELS = new Set([
  REL_TYPES.slideLayout,
  REL_TYPES.slideMaster,
  REL_TYPES.notesMaster,
  REL_TYPES.notesSlide,
  REL_TYPES.slide,
  REL_TYPES.theme
]);
const CHART_TYPE = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';
/** Theme roles whose colours a restyle follows into the template (the first of equal colours wins). */
const COLOR_ROLES = [
  ['accent1', 'accent1'],
  ['accent2', 'accent2'],
  ['accent3', 'accent3'],
  ['accent4', 'accent4'],
  ['accent5', 'accent5'],
  ['accent6', 'accent6'],
  ['dk2', 'tx2'],
  ['lt2', 'bg2']
];
const MIN_FONT = 800;
const MAX_FONT = 7200;
/** The size table text has when nothing sets one (PowerPoint's 18 pt). */
const DEFAULT_TABLE_FONT = 1800;
const SMALL_SCALE = 0.5;

/**
 * Whether a relationship is left behind: structure the template provides, and
 * comments (their authors are kept by the presentation, which is not copied;
 * PowerPoint would offer to repair the file).
 */
function isLeftBehind(rel) {
  return STRUCTURAL_RELS.has(rel.type) || rel.type.endsWith('/comments');
}

export class RestyleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RestyleError';
  }
}

// --- Reading the shapes of a slide ----------------------------------------------------

/** A string attribute; undefined when it is absent (the XML library returns '' then). */
function attr(element, name) {
  const value = element?.getAttribute(name);
  return value === null || value === undefined || value === '' ? undefined : value;
}

/** A numeric attribute; NaN when it is absent (not 0). */
function attrNumber(element, name) {
  const value = element?.getAttribute(name);
  return value === null || value === undefined || value === '' ? Number.NaN : Number(value);
}

/** The `a:xfrm`-like element holding a top-level shape's position, or null. */
function transformOf(element) {
  switch (element.localName) {
    case 'graphicFrame':
      return firstChild(element, 'xfrm');
    case 'grpSp':
      return firstChild(firstChild(element, 'grpSpPr'), 'xfrm');
    default:
      return firstChild(firstChild(element, 'spPr'), 'xfrm');
  }
}

function rectFromTransform(xfrm) {
  const off = firstChild(xfrm, 'off');
  const ext = firstChild(xfrm, 'ext');
  if (!off || !ext) return null;
  const rect = {
    x: attrNumber(off, 'x'),
    y: attrNumber(off, 'y'),
    cx: attrNumber(ext, 'cx'),
    cy: attrNumber(ext, 'cy')
  };
  return Object.values(rect).every(Number.isFinite) ? rect : null;
}

/** The placeholder element (`p:ph`) of a top-level shape, or null. */
function placeholderOf(element) {
  // `sp` keeps its properties in `nvSpPr`, `pic` in `nvPicPr`, `graphicFrame` in `nvGraphicFramePr` …
  const name = element.localName;
  const nv = firstChild(element, `nv${name[0].toUpperCase()}${name.slice(1)}Pr`);
  return firstChild(firstChild(nv, 'nvPr'), 'ph');
}

/** The layout placeholder a slide placeholder inherits its position from. */
function inheritedRect(ph, layout) {
  if (!ph || !layout) return null;
  const idx = attr(ph, 'idx');
  const type = attr(ph, 'type') || 'obj';
  const match =
    (idx !== undefined && layout.placeholders.find(p => p.idx === idx)) ||
    layout.placeholders.find(p => p.type === type);
  return match?.rect || null;
}

function roleOf(ph) {
  if (!ph) return 'content';
  const type = attr(ph, 'type');
  if (TITLE_TYPES.has(type)) return 'title';
  if (type === 'subTitle') return 'subtitle';
  if (FOOTER_TYPES.has(type)) return 'footer';
  return 'content';
}

function describeShape(element, layout) {
  const ph = placeholderOf(element);
  const xfrm = transformOf(element);
  return {
    element,
    ph,
    role: roleOf(ph),
    explicit: Boolean(xfrm),
    rect: (xfrm && rectFromTransform(xfrm)) || inheritedRect(ph, layout)
  };
}

function topLevelShapes(doc) {
  const tree = descendants(doc.documentElement, 'spTree')[0];
  return { tree, elements: childElements(tree).filter(e => !GROUP_PROPERTIES.has(e.localName)) };
}

// --- Binding to the template's placeholders --------------------------------------------

function bindPlaceholder(shape, target) {
  for (const name of ['type', 'idx', 'sz', 'orient', 'hasCustomPrompt'])
    shape.ph.removeAttribute(name);
  if (target.type && target.type !== 'obj') shape.ph.setAttribute('type', target.type);
  if (target.idx !== undefined) shape.ph.setAttribute('idx', target.idx);
}

function dropPlaceholder(shape) {
  const nvPr = shape.ph.parentNode;
  nvPr.removeChild(shape.ph);
  shape.ph = null;
}

/** Let a shape take its position from the placeholder it is bound to. */
function inheritPosition(shape) {
  const xfrm = transformOf(shape.element);
  if (xfrm) xfrm.parentNode.removeChild(xfrm);
}

function layoutPlaceholder(layout, predicate) {
  return layout.placeholders.find(predicate) || null;
}

/** Titles, subtitles and footers: the template's placeholders decide. Returns the shapes left. */
function bindFixedRoles(shapes, layout) {
  const used = new Set();
  const take = (predicate, shape) => {
    const target = layoutPlaceholder(layout, p => !used.has(p) && predicate(p));
    if (!target) return false;
    used.add(target);
    bindPlaceholder(shape, target);
    inheritPosition(shape);
    return true;
  };
  const rest = [];
  for (const shape of shapes) {
    const type = attr(shape.ph, 'type');
    let bound = false;
    if (shape.role === 'title')
      bound = take(p => p.type === 'title' || p.type === 'ctrTitle', shape);
    else if (shape.role === 'subtitle') {
      bound =
        take(p => p.type === 'subTitle', shape) ||
        take(
          p => !p.slot && TEXT_PLACEHOLDER_TYPES.has(p.type === 'obj' ? undefined : p.type),
          shape
        );
    } else if (shape.role === 'footer') {
      bound = take(p => p.type === type, shape);
      if (!bound) {
        shape.element.parentNode.removeChild(shape.element);
        continue;
      }
    }
    if (!bound) {
      // No such placeholder in the template: the shape is content like any other.
      if (shape.role !== 'content' && shape.ph) shape.role = 'content';
      rest.push(shape);
    }
  }
  return { rest, used };
}

// --- Placing the content -------------------------------------------------------------

function unionRect(rects) {
  const x = Math.min(...rects.map(r => r.x));
  const y = Math.min(...rects.map(r => r.y));
  const right = Math.max(...rects.map(r => r.x + r.cx));
  const bottom = Math.max(...rects.map(r => r.y + r.cy));
  return { x, y, cx: right - x, cy: bottom - y };
}

/** The scale and offset that fit `box` into `area` (top, centred), never larger than `limit`. */
function fitTransform(box, area, limit) {
  const scale = Math.min(area.cx / box.cx, area.cy / box.cy, limit);
  return {
    scale,
    dx: area.x + (area.cx - box.cx * scale) / 2 - box.x * scale,
    dy: area.y - box.y * scale
  };
}

function setRect(shape, rect) {
  let xfrm = transformOf(shape.element);
  if (!xfrm) xfrm = createTransform(shape.element);
  let off = firstChild(xfrm, 'off');
  let ext = firstChild(xfrm, 'ext');
  const doc = shape.element.ownerDocument;
  if (!off) {
    off = doc.createElementNS(NS.a, 'a:off');
    xfrm.insertBefore(off, xfrm.firstChild);
  }
  if (!ext) {
    ext = doc.createElementNS(NS.a, 'a:ext');
    xfrm.appendChild(ext);
  }
  off.setAttribute('x', String(Math.round(rect.x)));
  off.setAttribute('y', String(Math.round(rect.y)));
  ext.setAttribute('cx', String(Math.max(0, Math.round(rect.cx))));
  ext.setAttribute('cy', String(Math.max(0, Math.round(rect.cy))));
}

/** Add an empty position element where the shape type keeps it. */
function createTransform(element) {
  const doc = element.ownerDocument;
  if (element.localName === 'graphicFrame') {
    const xfrm = doc.createElementNS(NS.p, 'p:xfrm');
    const nv = firstChild(element, 'nvGraphicFramePr');
    element.insertBefore(xfrm, nv ? nv.nextSibling : element.firstChild);
    return xfrm;
  }
  const holderName = element.localName === 'grpSp' ? 'grpSpPr' : 'spPr';
  let holder = firstChild(element, holderName);
  if (!holder) {
    holder = doc.createElementNS(NS.p, `p:${holderName}`);
    element.appendChild(holder);
  }
  const xfrm = doc.createElementNS(NS.a, 'a:xfrm');
  holder.insertBefore(xfrm, holder.firstChild);
  return xfrm;
}

/** Replace a text body's autofit setting with "shrink text on overflow" at a scale. */
function setFontScale(bodyPr, scale) {
  for (const name of ['noAutofit', 'normAutofit', 'spAutoFit']) {
    const old = firstChild(bodyPr, name);
    if (old) bodyPr.removeChild(old);
  }
  const fit = bodyPr.ownerDocument.createElementNS(NS.a, 'a:normAutofit');
  fit.setAttribute('fontScale', String(Math.round(scale * 100000)));
  // The autofit choice comes after the text warp and before the 3-D settings.
  const warp = firstChild(bodyPr, 'prstTxWarp');
  bodyPr.insertBefore(fit, warp ? warp.nextSibling : bodyPr.firstChild);
}

const clampFont = size => Math.min(MAX_FONT, Math.max(MIN_FONT, Math.round(size)));

/** Table cells have no autofit: each run gets an explicit size, the inherited one scaled. */
function shrinkTableText(element, scale) {
  for (const run of descendants(element, 'r')) {
    let props = firstChild(run, 'rPr');
    if (!props) {
      props = run.ownerDocument.createElementNS(NS.a, 'a:rPr');
      run.insertBefore(props, run.firstChild);
    }
    const size = attrNumber(props, 'sz');
    props.setAttribute(
      'sz',
      String(clampFont((Number.isFinite(size) ? size : DEFAULT_TABLE_FONT) * scale))
    );
  }
}

/**
 * Text shrinks with its shape: shapes get "shrink text on overflow" at the
 * same scale, so sizes the text sets itself and sizes it inherits shrink alike.
 */
function shrinkText(element, scale) {
  if (element.localName === 'graphicFrame') {
    shrinkTableText(element, scale);
    return;
  }
  for (const bodyPr of descendants(element, 'bodyPr')) setFontScale(bodyPr, scale);
}

function scaleTable(element, scale) {
  for (const col of descendants(element, 'gridCol')) {
    col.setAttribute('w', String(Math.round(attrNumber(col, 'w') * scale)));
  }
  for (const row of descendants(element, 'tr')) {
    row.setAttribute('h', String(Math.round(attrNumber(row, 'h') * scale)));
  }
}

function isTextPlaceholder(shape) {
  return (
    shape.ph &&
    shape.element.localName === 'sp' &&
    TEXT_PLACEHOLDER_TYPES.has(attr(shape.ph, 'type'))
  );
}

/** Content placeholders of a layout, left to right, then top to bottom. */
function targetContentPlaceholders(layout) {
  return contentPlaceholders(layout)
    .filter(p => p.type === 'obj' || p.type === 'body' || p.type === 'tx')
    .sort((a, b) => a.rect.x - b.rect.x || a.rect.y - b.rect.y);
}

function readingOrder(a, b) {
  return (a.rect?.x ?? 0) - (b.rect?.x ?? 0) || (a.rect?.y ?? 0) - (b.rect?.y ?? 0);
}

/** Body text only: each body takes a content placeholder of the template and its position. */
function placeInPlaceholders(bodies, targets) {
  [...bodies].sort(readingOrder).forEach((shape, i) => {
    bindPlaceholder(shape, targets[i]);
    inheritPosition(shape);
  });
}

/** Mixed content: keep the arrangement, scaled into the template's content area. */
function placeScaled(shapes, ctx) {
  const placed = shapes.filter(s => s.rect);
  if (!placed.length) return null;
  const limit = Math.max(1, ctx.slideScale);
  const { scale, dx, dy } = fitTransform(unionRect(placed.map(s => s.rect)), ctx.area, limit);
  const targets = targetContentPlaceholders(ctx.layout).filter(p => !ctx.used.has(p));
  for (const shape of placed) {
    setRect(shape, {
      x: shape.rect.x * scale + dx,
      y: shape.rect.y * scale + dy,
      cx: shape.rect.cx * scale,
      cy: shape.rect.cy * scale
    });
    if (shape.ph && isTextPlaceholder(shape) && targets.length)
      bindPlaceholder(shape, targets.shift());
    else if (shape.ph) dropPlaceholder(shape);
    // Text only shrinks with its shape: a larger box does not need larger text.
    if (scale < 1) shrinkText(shape.element, scale);
    if (shape.element.localName === 'graphicFrame') scaleTable(shape.element, scale);
  }
  return scale;
}

function placeContent(shapes, ctx) {
  if (!shapes.length) return;
  if (shapes.some(s => !s.rect && !s.ph)) {
    ctx.warnings.push(
      `Slide ${ctx.number}: a shape of a kind that cannot be moved (an equation, ink or a 3-D model) stays where it was; check the slide.`
    );
  }
  const bodies = shapes.filter(isTextPlaceholder);
  const targets = targetContentPlaceholders(ctx.layout).filter(p => !ctx.used.has(p));
  if (bodies.length === shapes.length && bodies.length <= targets.length) {
    placeInPlaceholders(bodies, targets);
    return;
  }
  const scale = placeScaled(shapes, ctx);
  if (scale !== null && scale < SMALL_SCALE) {
    ctx.warnings.push(
      `Slide ${ctx.number}: its content was reduced to ${Math.round(scale * 100)} % to fit the template's content area; check that it is still readable.`
    );
  }
}

// --- Footers, background ---------------------------------------------------------------

function nextShapeId(doc) {
  return (
    Math.max(1, ...descendants(doc.documentElement, 'cNvPr').map(n => attrNumber(n, 'id') || 0)) + 1
  );
}

function footerShape(id, target, text) {
  const body =
    target.type === 'sldNum'
      ? '<a:fld id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="slidenum"><a:rPr lang="en-US"/><a:t>‹#›</a:t></a:fld>'
      : `<a:r><a:rPr lang="en-US"/><a:t>${xmlEscape(text)}</a:t></a:r>`;
  const idx = target.idx !== undefined ? ` idx="${xmlEscape(target.idx)}"` : '';
  return `<p:sp ${PML_NAMESPACES}><p:nvSpPr><p:cNvPr id="${id}" name="${target.type === 'sldNum' ? 'Slide Number' : 'Footer'}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="${target.type}" sz="quarter"${idx}/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p>${body}</a:p></p:txBody></p:sp>`;
}

/** The template's footer text and slide numbers, where the slide has none (not on title slides). */
function addFooters(doc, tree, layout, kind, options) {
  if (kind === 'title') return;
  const wanted = [];
  if (options.footer) wanted.push(['ftr', options.footer]);
  if (options.slideNumbers) wanted.push(['sldNum', '']);
  const present = new Set(descendants(tree, 'ph').map(ph => ph.getAttribute('type')));
  let id = nextShapeId(doc);
  for (const [type, text] of wanted) {
    const target = layoutPlaceholder(layout, p => p.type === type);
    if (!target || present.has(type)) continue;
    const fragment = parseXml(footerShape(id, target, text), 'footer');
    tree.appendChild(doc.importNode(fragment.documentElement, true));
    id += 1;
  }
}

/**
 * The colours of the old theme by hex, as the scheme colour of the same role:
 * what the deck set explicitly to "accent 2" becomes the template's accent 2.
 */
function themeColorMap(theme) {
  const map = new Map();
  for (const [role, scheme] of COLOR_ROLES) {
    const hex = theme?.colors?.[role];
    if (hex && !map.has(hex)) map.set(hex, scheme);
  }
  return map;
}

/** Replace explicit colours that are old theme colours with the template's scheme colours. */
function remapColors(root, map) {
  if (!map.size) return;
  for (const node of descendants(root, 'srgbClr')) {
    const scheme = map.get(String(node.getAttribute('val')).toUpperCase());
    if (!scheme) continue;
    const replacement = node.ownerDocument.createElementNS(NS.a, 'a:schemeClr');
    replacement.setAttribute('val', scheme);
    while (node.firstChild) replacement.appendChild(node.firstChild);
    node.parentNode.replaceChild(replacement, node);
  }
}

function stripBackground(doc) {
  const cSld = descendants(doc.documentElement, 'cSld')[0];
  const background = firstChild(cSld, 'bg');
  if (background) cSld.removeChild(background);
  const override = firstChild(doc.documentElement, 'clrMapOvr');
  if (override) {
    for (const child of childElements(override)) override.removeChild(child);
    override.appendChild(doc.createElementNS(NS.a, 'a:masterClrMapping'));
  }
}

/**
 * Restyle one slide's XML for a template layout.
 *
 * @returns {void} The document is changed in place.
 */
function restyleSlide(doc, ctx) {
  stripBackground(doc);
  const { tree, elements } = topLevelShapes(doc);
  const shapes = elements.map(element => describeShape(element, ctx.sourceLayout));
  const { rest, used } = bindFixedRoles(shapes, ctx.layout);
  ctx.used = used;
  placeContent(rest, ctx);
  addFooters(doc, tree, ctx.layout, ctx.kind, ctx.options);
  remapColors(doc.documentElement, ctx.colorMap);
}

// --- Importing parts -------------------------------------------------------------------

function freeName(zip, path) {
  if (!zip.file(path)) return path;
  const dot = path.lastIndexOf('.');
  const stem = dot > path.lastIndexOf('/') ? path.slice(0, dot) : path;
  const extension = dot > path.lastIndexOf('/') ? path.slice(dot) : '';
  for (let n = 1; ; n += 1) {
    const candidate = `${stem}-r${n}${extension}`;
    if (!zip.file(candidate)) return candidate;
  }
}

/** Copy a part and what it refers to (pictures, charts, their workbooks) into the template's package. */
async function copyPart(ctx, sourcePath) {
  if (ctx.copied.has(sourcePath)) return ctx.copied.get(sourcePath);
  const file = ctx.source.zip.file(sourcePath);
  if (!file) return null;
  const destination = freeName(ctx.target.zip, sourcePath);
  ctx.copied.set(sourcePath, destination);
  const type = ctx.sourceTypes.typeOf(sourcePath);
  if (type === CHART_TYPE) {
    // Series, axes and text follow the template's theme where they followed the old one.
    const chart = parseXml(await file.async('string'), sourcePath);
    remapColors(chart.documentElement, ctx.colorMap);
    ctx.target.zip.file(destination, serializeXml(chart));
  } else {
    ctx.target.zip.file(destination, await file.async('nodebuffer'));
  }
  if (type && ctx.types.typeOf(destination) !== type) ctx.types.setOverride(destination, type);
  const rels = await readRels(ctx.source.zip, sourcePath);
  if (rels.length) {
    writeRels(
      ctx.target.zip,
      destination,
      await copyRelationships(ctx, sourcePath, destination, rels)
    );
  }
  return destination;
}

async function copyRelationships(ctx, sourcePath, destination, rels) {
  const out = [];
  for (const rel of rels) {
    if (rel.external) {
      out.push(rel);
      continue;
    }
    if (isLeftBehind(rel)) continue;
    const copied = await copyPart(ctx, resolveTarget(sourcePath, rel.target));
    if (copied) out.push({ ...rel, target: relativeTarget(destination, copied) });
  }
  return out;
}

/** The notes of a slide, on the template's notes master. */
async function copyNotes(ctx, notesPath, slidePath) {
  const file = ctx.source.zip.file(notesPath);
  if (!file) return null;
  const destination = uniquePath(ctx.target.zip, 'ppt/notesSlides/notesSlide{n}.xml');
  ctx.target.zip.file(destination, await file.async('nodebuffer'));
  ctx.types.setOverride(destination, NOTES_TYPE);
  const rels = await copyRelationships(
    ctx,
    notesPath,
    destination,
    await readRels(ctx.source.zip, notesPath)
  );
  // Both ids are chosen before either entry is added, so they cannot be the same.
  const masterId = nextRelId(rels);
  const slideId = nextRelId([...rels, { id: masterId }]);
  rels.push(
    {
      id: masterId,
      type: REL_TYPES.notesMaster,
      target: relativeTarget(destination, ctx.notesMaster)
    },
    { id: slideId, type: REL_TYPES.slide, target: relativeTarget(destination, slidePath) }
  );
  writeRels(ctx.target.zip, destination, rels);
  return destination;
}

/** One relationship of a source slide, for the imported slide (null: dropped). */
async function mapSlideRelationship(ctx, entry, newPath, rel) {
  if (rel.external) return rel;
  const target = resolveTarget(entry.path, rel.target);
  if (rel.type === REL_TYPES.notesSlide) {
    const notes = await copyNotes(ctx, target, newPath);
    return notes ? { ...rel, target: relativeTarget(newPath, notes) } : null;
  }
  if (rel.type === REL_TYPES.slide) {
    const other = ctx.slideMap.get(target);
    return other ? { ...rel, target: relativeTarget(newPath, other) } : null;
  }
  if (isLeftBehind(rel)) return null;
  const copied = await copyPart(ctx, target);
  return copied ? { ...rel, target: relativeTarget(newPath, copied) } : null;
}

// --- The deck ---------------------------------------------------------------------------

async function slideEntries(source) {
  const list = firstChild(source.presentation.documentElement, 'sldIdLst');
  const paths = childElements(list, 'sldId')
    .map(slideId => slideId.getAttributeNS(NS.r, 'id') || slideId.getAttribute('r:id'))
    .map(relId => source.presRels.find(r => r.id === relId))
    .filter(Boolean)
    .map(rel => resolveTarget(PRESENTATION, rel.target));
  // Reading is independent per slide; the importing that follows is not (see `copyPart`).
  return Promise.all(paths.map(async path => ({ path, rels: await readRels(source.zip, path) })));
}

async function restyleEntry(ctx, entry, index) {
  const doc = await readXmlPart(ctx.source.zip, entry.path);
  const layoutRel = entry.rels.find(r => r.type === REL_TYPES.slideLayout);
  const layoutPath = layoutRel ? resolveTarget(entry.path, layoutRel.target) : null;
  const sourceLayout = ctx.source.layouts.find(l => l.path === layoutPath) || null;
  const kind = (sourceLayout && layoutKind(sourceLayout)) || (index === 0 ? 'title' : 'content');
  const layout = ctx.chosen[kind] || ctx.chosen.content;
  restyleSlide(doc, {
    ...ctx,
    sourceLayout,
    layout,
    kind,
    number: index + 1,
    area: contentArea(layout, ctx.chosen, ctx.target.slideSize)
  });
  const newPath = ctx.slideMap.get(entry.path);
  const rels = [
    {
      id: layoutRel?.id || nextRelId(entry.rels),
      type: REL_TYPES.slideLayout,
      target: relativeTarget(newPath, layout.path)
    }
  ];
  for (const rel of entry.rels) {
    if (rel === layoutRel) continue;
    const mapped = await mapSlideRelationship(ctx, entry, newPath, rel);
    if (mapped) rels.push(mapped);
  }
  writeXmlPart(ctx.target.zip, newPath, doc);
  writeRels(ctx.target.zip, newPath, rels);
  ctx.types.setOverride(newPath, SLIDE_TYPE);
}

/** List the imported slides in the presentation. */
function registerSlides(target, paths) {
  const root = target.presentation.documentElement;
  const list = target.presentation.createElementNS(NS.p, 'p:sldIdLst');
  paths.forEach((path, index) => {
    const relId = nextRelId(target.presRels);
    target.presRels.push({
      id: relId,
      type: REL_TYPES.slide,
      target: relativeTarget(PRESENTATION, path)
    });
    const entry = target.presentation.createElementNS(NS.p, 'p:sldId');
    entry.setAttribute('id', String(256 + index));
    entry.setAttributeNS(NS.r, 'r:id', relId);
    list.appendChild(entry);
  });
  insertPresentationChild(root, list, ['sldMasterIdLst', 'notesMasterIdLst', 'handoutMasterIdLst']);
  writeXmlPart(target.zip, PRESENTATION, target.presentation);
  writeRels(target.zip, PRESENTATION, target.presRels);
}

/**
 * Put a presentation onto a PowerPoint template.
 *
 * @param {Buffer|Uint8Array} sourceBuffer - The deck to restyle (.pptx).
 * @param {Buffer|Uint8Array} templateBuffer - The template (.potx/.pptx): its
 *   master, layouts and theme. Its own sample slides are dropped.
 * @param {Object} [options]
 * @param {Object} [options.layouts] - Layout names by kind (`pptx.layouts` of the document template).
 * @param {Object} [options.slots] - The text slots the template declares (`pptx.slots`); they are not content areas.
 * @param {string} [options.footer] - Footer text for slides that have none.
 * @param {boolean} [options.slideNumbers] - Slide numbers for slides that have none.
 * @param {string} [options.title] - Document title (default: kept empty).
 * @param {string} [options.author]
 * @param {string} [options.language]
 * @returns {Promise<{ buffer: Buffer, slides: number, warnings: string[] }>}
 */
export async function restylePptx(sourceBuffer, templateBuffer, options = {}) {
  const source = await loadPresentationTemplate(sourceBuffer);
  const target = await loadPresentationTemplate(templateBuffer, { slots: options.slots });
  await removeTemplateSlides(target);
  const types = await ContentTypes.read(target.zip);
  // A .potx template names its main part a template; the result is a presentation.
  types.setOverride(PRESENTATION, PRESENTATION_TYPE);
  const entries = await slideEntries(source);
  if (!entries.length) throw new RestyleError('The presentation has no slides.');

  const hasNotes = entries.some(e => e.rels.some(r => r.type === REL_TYPES.notesSlide));
  const ctx = {
    source,
    target,
    types,
    sourceTypes: await ContentTypes.read(source.zip),
    chosen: chooseLayouts(target.layouts, options.layouts),
    options,
    notesMaster: hasNotes ? ensureNotesMaster(target, types) : target.notesMaster,
    colorMap: themeColorMap(source.masters[0]?.theme),
    copied: new Map(),
    slideMap: new Map(),
    warnings: [],
    // A deck of another size: content may grow with the slide, not beyond.
    slideScale: Math.max(
      target.slideSize.cx / source.slideSize.cx,
      target.slideSize.cy / source.slideSize.cy
    )
  };
  // Every slide gets its place first, so links between slides can be mapped.
  for (const entry of entries) {
    const path = uniquePath(target.zip, 'ppt/slides/slide{n}.xml');
    target.zip.file(path, '');
    ctx.slideMap.set(entry.path, path);
  }
  for (const [index, entry] of entries.entries()) await restyleEntry(ctx, entry, index);
  registerSlides(
    target,
    entries.map(e => ctx.slideMap.get(e.path))
  );

  target.zip.file(
    'docProps/app.xml',
    `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>iHub Apps</Application><Slides>${entries.length}</Slides></Properties>`
  );
  await setCoreProperties(target.zip, types, {
    title: options.title,
    author: options.author,
    language: options.language
  });
  await removeUnreachableParts(target.zip, types);
  types.write(target.zip);
  return { buffer: await writePackage(target.zip), slides: entries.length, warnings: ctx.warnings };
}
