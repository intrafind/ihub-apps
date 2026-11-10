// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import {
  ContentTypes,
  IMAGE_CONTENT_TYPES,
  NS,
  childElements,
  descendants,
  nextRelId,
  openPackage,
  parseXml,
  readRels,
  readXmlPart,
  relativeTarget,
  resolveTarget,
  writePackage,
  writeRels,
  writeXmlPart,
  xmlEscape,
  REL_TYPES
} from '../ooxml/opcPackage.js';
import { imageInfo } from '../templates/templateAssets.js';
import { EMU_PER_INCH, PML_NAMESPACES } from './pptxXml.js';

/**
 * The slide frame: a document template's cover and frame for presentations.
 *
 * A finished deck gets the corporate chrome put on it, without its content
 * being rebuilt:
 *
 * - **Cover (the first slide):** its shapes are replaced by a full-bleed
 *   background picture, a white info panel top left holding the logo, the
 *   title and the date, and a white strip bottom right with a footer text and
 *   a small logo. The title and date are the ones the slide had.
 * - **Every other slide:** its shapes stay as they are; a strip along the top
 *   edge, a strip along the left edge and the logo bottom right are added on
 *   top.
 *
 * The geometry comes from a reference canvas of 13.333 x 7.5 inches and is
 * scaled to the slide's size. The strips keep the proportions of their image.
 * Everything that is the brand's (pictures, logo, colour, font) comes from the
 * document template.
 */

const REFERENCE = { width: 13.333, height: 7.5 };

/** Cover geometry in reference inches: the one composition the frame has. */
const COVER = Object.freeze({
  panel: { x: 0, y: 0, w: 6.7, h: 3.1 },
  logo: { x: 0.41, y: 0.41, w: 5.88 },
  title: { x: 0.38, y: 1.3, w: 6.29, h: 1.1 },
  date: { x: 0.38, y: 2.45, w: 6.29, h: 0.4 },
  strip: { x: 7.906, y: 7.151, w: 5.427, h: 0.349 },
  footerText: { x: 8.115, y: 7.188, w: 3.641, h: 0.274 },
  smallLogo: { x: 11.875, y: 7.252, w: 1.07 }
});

const CONTENT_LOGO = Object.freeze({ widthInches: 1.0, marginInches: 0.25 });

const DEFAULT_TEXT_COLOR = '58585A';
const DEFAULT_FONT = 'Calibri';
const MAX_COVER_TEXT = 300;

const PRESENTATION = 'ppt/presentation.xml';

export class SlideFrameError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SlideFrameError';
  }
}

/** Whether a frame setting has something to draw. */
export function frameHasContent(frame) {
  return Boolean(frame && (frame.coverBackground || frame.stripTop || frame.stripLeft));
}

function hex(value, fallback) {
  const clean = String(value || '').replace('#', '');
  return /^[0-9a-f]{6}$/i.test(clean) ? clean.toUpperCase() : fallback;
}

/** An image with its pixel size and a normalized extension, or null. */
function describeImage(image) {
  if (!image?.data?.length) return null;
  const data = Buffer.from(image.data);
  const info = imageInfo(data);
  if (!info) return null;
  const width = image.width > 0 ? image.width : info.width;
  const height = image.height > 0 ? image.height : info.height;
  if (!(width > 0 && height > 0)) return null;
  return { data, extension: info.type === 'png' ? 'png' : 'jpeg', width, height };
}

function clip(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_COVER_TEXT);
}

// --- Reading the deck ------------------------------------------------------------

/** The slide parts in presentation order, and the slide size in EMU. */
async function readSlides(zip) {
  const presentation = await readXmlPart(zip, PRESENTATION);
  if (!presentation) throw new SlideFrameError('The file is not a PowerPoint presentation.');
  const rels = await readRels(zip, PRESENTATION);
  const size = descendants(presentation.documentElement, 'sldSz')[0];
  const slideSize = {
    cx: Number(size?.getAttribute('cx')) || 12192000,
    cy: Number(size?.getAttribute('cy')) || 6858000
  };
  const paths = [];
  for (const id of descendants(presentation.documentElement, 'sldId')) {
    const relId = id.getAttributeNS(NS.r, 'id') || id.getAttribute('r:id');
    const rel = rels.find(r => r.id === relId);
    if (rel) paths.push(resolveTarget(PRESENTATION, rel.target));
  }
  return { paths, slideSize };
}

function shapeText(sp) {
  return descendants(sp, 'p')
    .map(p =>
      descendants(p, 't')
        .map(t => t.textContent)
        .join('')
    )
    .join(' ')
    .trim();
}

/**
 * The cover's title and date from the first slide: the title and subtitle
 * placeholders when it has them, otherwise its first two text shapes.
 */
export function coverTextOf(slideDoc) {
  const shapes = descendants(slideDoc.documentElement, 'sp');
  let title = '';
  let date = '';
  const texts = [];
  for (const sp of shapes) {
    const text = shapeText(sp);
    if (!text) continue;
    const ph = descendants(sp, 'ph')[0];
    const type = ph?.getAttribute('type');
    if (!title && (type === 'ctrTitle' || type === 'title')) title = text;
    else if (!date && type === 'subTitle') date = text;
    else if (!['ftr', 'sldNum', 'dt'].includes(type)) texts.push(text);
  }
  if (!title) title = texts.shift() || '';
  if (!date) date = texts.shift() || '';
  return { title: clip(title), date: clip(date) };
}

// --- Shapes ------------------------------------------------------------------------

const emu = inches => Math.round(inches * EMU_PER_INCH);

function xfrm({ x, y, cx, cy }) {
  return `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`;
}

function pictureXml({ id, name, descr = '', relId, rect, crop = '' }) {
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${xmlEscape(name)}" descr="${xmlEscape(descr)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr userDrawn="1"/></p:nvPicPr><p:blipFill><a:blip r:embed="${relId}"/>${crop}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(rect)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
}

function rectXml({ id, name, rect, color }) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xmlEscape(name)}"/><p:cNvSpPr/><p:nvPr userDrawn="1"/></p:nvSpPr><p:spPr>${xfrm(rect)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr rtlCol="0" anchor="ctr"/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`;
}

function textXml({ id, name, rect, text, size, bold, color, font, lang }) {
  if (!text) return '';
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xmlEscape(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr userDrawn="1"/></p:nvSpPr><p:spPr>${xfrm(rect)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0" anchor="t"><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p><a:pPr algn="l"/><a:r><a:rPr lang="${xmlEscape(lang)}" sz="${size * 100}"${bold ? ' b="1"' : ''} dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="${xmlEscape(font)}"/></a:rPr><a:t>${xmlEscape(text)}</a:t></a:r></a:p></p:txBody></p:sp>`;
}

/** `a:srcRect` that crops a picture to the slide's proportions (no distortion). */
function coverCrop(image, slideSize) {
  const imageRatio = image.width / image.height;
  const slideRatio = slideSize.cx / slideSize.cy;
  if (Math.abs(imageRatio - slideRatio) < 0.005) return '';
  if (imageRatio > slideRatio) {
    const side = Math.round(((1 - slideRatio / imageRatio) / 2) * 100000);
    return `<a:srcRect l="${side}" r="${side}"/>`;
  }
  const side = Math.round(((1 - imageRatio / slideRatio) / 2) * 100000);
  return `<a:srcRect t="${side}" b="${side}"/>`;
}

// --- Applying ----------------------------------------------------------------------

/**
 * Put the frame on a presentation.
 *
 * @param {Buffer|Uint8Array} buffer - The finished .pptx.
 * @param {Object} frame
 * @param {Object} [frame.coverBackground] - `{ data, extension, width?, height? }`: full-bleed cover picture.
 * @param {Object} [frame.stripTop] - Picture stretched along the top edge (keeps its proportions).
 * @param {Object} [frame.stripLeft] - Picture along the left edge, below the top strip.
 * @param {Object} [frame.logo] - The brand logo (content slides, bottom right; cover panel).
 * @param {string} [frame.textColor] - Hex colour of the cover texts.
 * @param {string} [frame.font] - Font of the cover texts.
 * @param {string} [frame.panelColor] - Hex colour of the cover's panel and footer strip (white).
 * @param {Object} [options]
 * @param {boolean} [options.cover=true] - Rebuild the first slide as the cover.
 * @param {string} [options.title] - Cover title; default: the first slide's own.
 * @param {string} [options.date] - Cover date / subtitle; default: the first slide's own.
 * @param {string} [options.footer] - Cover footer text, `{title}` and `{date}` filled in;
 *   default: "title · date".
 * @param {string} [options.lang='en-US']
 * @returns {Promise<{ buffer: Buffer, slides: number, cover: boolean }>}
 */
export async function applySlideFrame(buffer, frame, options = {}) {
  const images = {
    coverBackground: describeImage(frame?.coverBackground),
    stripTop: describeImage(frame?.stripTop),
    stripLeft: describeImage(frame?.stripLeft),
    logo: describeImage(frame?.logo)
  };
  if (!images.coverBackground && !images.stripTop && !images.stripLeft) {
    throw new SlideFrameError('The frame has no pictures to draw.');
  }
  const zip = await openPackage(buffer);
  const types = await ContentTypes.read(zip);
  const { paths, slideSize } = await readSlides(zip);
  if (!paths.length) throw new SlideFrameError('The presentation has no slides.');

  const scaler = scalerFor(slideSize);
  const style = {
    lang: options.lang || 'en-US',
    textColor: hex(frame.textColor, DEFAULT_TEXT_COLOR),
    panelColor: hex(frame.panelColor, 'FFFFFF'),
    font: frame.font || DEFAULT_FONT
  };
  const mediaPath = mediaRegistry(zip, types, images);
  const coverWanted = options.cover !== false && Boolean(images.coverBackground);
  let coverBuilt = false;

  const slides = await Promise.all(
    paths.map((slidePath, index) => loadSlide(zip, slidePath, index))
  );
  for (const slide of slides.filter(Boolean)) {
    const { doc, tree } = slide;
    const relFor = key => slide.relFor(key, mediaPath);
    const isCover = slide.index === 0 && coverWanted;
    let shapes;
    if (isCover) {
      shapes = coverShapes({
        images,
        scaler,
        slideSize,
        style,
        text: coverText(doc, options),
        id: slide.id,
        relFor
      });
      // The cover replaces whatever the first slide showed.
      clearShapes(tree);
      coverBuilt = true;
    } else {
      // Content slide: the shapes stay; the frame goes on top.
      shapes = contentShapes({ images, scaler, slideSize, id: slide.id, relFor });
    }
    appendShapes(doc, tree, shapes);
    writeXmlPart(zip, slide.path, doc);
    writeRels(zip, slide.path, slide.rels);
  }

  types.write(zip);
  return { buffer: await writePackage(zip), slides: paths.length, cover: coverBuilt };
}

// --- Pieces of applySlideFrame -------------------------------------------------------

/** Reference inches scaled to the slide: `ix`/`iy` for lengths, `box` for a rectangle. */
function scalerFor(slideSize) {
  const sx = slideSize.cx / emu(REFERENCE.width);
  const sy = slideSize.cy / emu(REFERENCE.height);
  const ix = inches => Math.round(emu(inches) * sx);
  const iy = inches => Math.round(emu(inches) * sy);
  return {
    ix,
    iy,
    box: (b, h = b.h) => ({ x: ix(b.x), y: iy(b.y), cx: ix(b.w), cy: iy(h) }),
    // Font sizes follow the smaller axis, so text stays readable.
    scale: Math.min(sx, sy)
  };
}

/** One media part per picture, shared by every slide that shows it. */
function mediaRegistry(zip, types, images) {
  const media = new Map();
  return key => {
    if (!media.has(key)) {
      const image = images[key];
      const target = `ppt/media/ihub-frame-${key}.${image.extension}`;
      zip.file(target, image.data);
      types.ensureDefault(image.extension, IMAGE_CONTENT_TYPES[image.extension]);
      media.set(key, target);
    }
    return media.get(key);
  };
}

/** A slide part with its relationships and the next free shape id; null without a shape tree. */
async function loadSlide(zip, slidePath, index) {
  const doc = await readXmlPart(zip, slidePath);
  const tree = descendants(doc.documentElement, 'spTree')[0];
  if (!tree) return null;
  const rels = await readRels(zip, slidePath);
  let nextId =
    Math.max(
      1,
      ...descendants(doc.documentElement, 'cNvPr').map(n => Number(n.getAttribute('id')) || 0)
    ) + 1;
  return {
    index,
    path: slidePath,
    doc,
    tree,
    rels,
    id: () => nextId++,
    /** The relationship id of a frame picture on this slide (added when it is new). */
    relFor(key, mediaPath) {
      const target = relativeTarget(slidePath, mediaPath(key));
      let rel = rels.find(r => r.type === REL_TYPES.image && r.target === target);
      if (!rel) {
        rel = { id: nextRelId(rels), type: REL_TYPES.image, target };
        rels.push(rel);
      }
      return rel.id;
    }
  };
}

/** The cover's title, date and footer: the options, else the first slide's own. */
function coverText(doc, options) {
  const own = coverTextOf(doc);
  const title = clip(options.title) || own.title;
  const date = clip(options.date) || own.date;
  const footer = options.footer
    ? clip(String(options.footer).replaceAll('{title}', title).replaceAll('{date}', date))
    : [title, date].filter(Boolean).join(' · ');
  return { title, date, footer };
}

/** Remove every shape of a slide (the group properties stay). */
function clearShapes(tree) {
  for (const child of childElements(tree)) {
    if (!['nvGrpSpPr', 'grpSpPr'].includes(child.localName)) tree.removeChild(child);
  }
}

function appendShapes(doc, tree, shapes) {
  const fragment = parseXml(
    `<p:spTree ${PML_NAMESPACES}>${shapes.join('')}</p:spTree>`,
    'frame shapes'
  );
  for (const shape of childElements(fragment.documentElement)) {
    tree.appendChild(doc.importNode(shape, true));
  }
}

/** A picture of a logo at a width, in the logo's proportions. */
function logoPicture({ id, name, relId, logo, ix, iy, at }) {
  const cx = ix(at.w);
  return pictureXml({
    id,
    name,
    descr: 'Logo',
    relId,
    rect: { x: ix(at.x), y: iy(at.y), cx, cy: Math.round(cx * (logo.height / logo.width)) }
  });
}

/** The cover: picture, white panel with logo, title and date, footer strip with text and logo. */
function coverShapes({ images, scaler, slideSize, style, text, id, relFor }) {
  const { ix, iy, box, scale } = scaler;
  const { logo } = images;
  const shapes = [
    pictureXml({
      id: id(),
      name: 'Cover background',
      relId: relFor('coverBackground'),
      rect: { x: 0, y: 0, cx: slideSize.cx, cy: slideSize.cy },
      crop: coverCrop(images.coverBackground, slideSize)
    }),
    rectXml({ id: id(), name: 'Cover panel', rect: box(COVER.panel), color: style.panelColor })
  ];
  if (logo) {
    shapes.push(
      logoPicture({ id: id(), name: 'Logo', relId: relFor('logo'), logo, ix, iy, at: COVER.logo })
    );
  }
  const textStyle = { color: style.textColor, font: style.font, lang: style.lang };
  shapes.push(
    textXml({
      id: id(),
      name: 'Title',
      rect: box(COVER.title),
      text: text.title,
      size: Math.max(14, Math.round(26 * scale)),
      bold: true,
      ...textStyle
    }),
    textXml({
      id: id(),
      name: 'Date',
      rect: box(COVER.date),
      text: text.date,
      size: Math.max(9, Math.round(14 * scale)),
      ...textStyle
    }),
    rectXml({ id: id(), name: 'Footer strip', rect: box(COVER.strip), color: style.panelColor }),
    textXml({
      id: id(),
      name: 'Footer',
      rect: box(COVER.footerText),
      text: text.footer,
      size: Math.max(7, Math.round(9 * scale)),
      ...textStyle
    })
  );
  if (logo) {
    shapes.push(
      logoPicture({
        id: id(),
        name: 'Logo (small)',
        relId: relFor('logo'),
        logo,
        ix,
        iy,
        at: COVER.smallLogo
      })
    );
  }
  return shapes;
}

/** A content slide's frame: strip along the top, strip along the left edge, logo bottom right. */
function contentShapes({ images, scaler, slideSize, id, relFor }) {
  const { ix } = scaler;
  const shapes = [];
  const topHeight = images.stripTop
    ? Math.round(slideSize.cx * (images.stripTop.height / images.stripTop.width))
    : 0;
  if (images.stripTop) {
    shapes.push(
      pictureXml({
        id: id(),
        name: 'Frame top',
        relId: relFor('stripTop'),
        rect: { x: 0, y: 0, cx: slideSize.cx, cy: topHeight }
      })
    );
  }
  if (images.stripLeft) {
    const height = slideSize.cy - topHeight;
    shapes.push(
      pictureXml({
        id: id(),
        name: 'Frame left',
        relId: relFor('stripLeft'),
        rect: {
          x: 0,
          y: topHeight,
          cx: Math.round(height * (images.stripLeft.width / images.stripLeft.height)),
          cy: height
        }
      })
    );
  }
  if (images.logo) {
    const width = ix(CONTENT_LOGO.widthInches);
    const height = Math.round(width * (images.logo.height / images.logo.width));
    const margin = ix(CONTENT_LOGO.marginInches);
    shapes.push(
      pictureXml({
        id: id(),
        name: 'Logo',
        descr: 'Logo',
        relId: relFor('logo'),
        rect: {
          x: slideSize.cx - width - margin,
          y: slideSize.cy - height - margin,
          cx: width,
          cy: height
        }
      })
    );
  }
  return shapes;
}
