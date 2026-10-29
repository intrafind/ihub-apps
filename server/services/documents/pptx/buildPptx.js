// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import {
  ContentTypes,
  IMAGE_CONTENT_TYPES,
  NS,
  REL_TYPES,
  childElements,
  descendants,
  firstChild,
  nextRelId,
  readRels,
  relativeTarget,
  removeUnreachableParts,
  resolveTarget,
  setCoreProperties,
  writePackage,
  writeRels,
  writeXmlPart,
  xmlEscape
} from '../ooxml/opcPackage.js';
import { checkImageDataUri, imagePixelSize, LIMITS } from '../pdf/validators.js';
import { addNotesMaster, NOTES_MASTER_TYPE, THEME_TYPE } from './baseTemplate.js';
import { renderCharts, sanitizeChart } from './charts.js';
import {
  chooseLayouts,
  contentPlaceholders,
  loadPresentationTemplate,
  titlePlaceholder
} from './pptxTemplate.js';
import {
  EMU_PER_INCH,
  GROUP_PROPS,
  PML_NAMESPACES,
  XML_HEAD,
  markdownToSlideText,
  paragraphsXml,
  pictureShape,
  placeholderShape,
  tableFrame,
  textBoxShape,
  textLength
} from './pptxXml.js';

/**
 * Build a presentation by filling a template with slides.
 *
 * Every slide uses one of the template's layouts (title, section, content,
 * two columns, title only, blank) and puts its title and text into the
 * layout's own placeholders, so fonts, sizes, colours, bullets, logos and
 * backgrounds come from the template. Tables, pictures and charts are placed
 * in the layout's content area. Slides the template file itself contained
 * (a sample deck) are removed.
 *
 * @typedef {Object} SlideSpec
 * @property {string} [layout] - `title`, `section`, `content`, `two-column`,
 *   `title-only`, `blank`.
 * @property {string} [title]
 * @property {string} [subtitle] - Title and section slides.
 * @property {string} [text] - Markdown: paragraphs, bullet and numbered lists.
 * @property {Object} [table] - `{ header: string[], rows: string[][], align?: string[] }`.
 * @property {Object} [chart] - See `charts.js`.
 * @property {Object|string} [image] - A `data:` URI or `{ data, caption }`.
 * @property {Object} [left] - Two-column slides: `{ heading, text, table, chart, image }`.
 * @property {Object} [right]
 * @property {string} [notes] - Speaker notes.
 */

const SLIDE_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
const NOTES_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml';
const CHART_TYPE = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PRESENTATION_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';
const PRESENTATION = 'ppt/presentation.xml';

export const DECK_LIMITS = Object.freeze({
  maxSlides: 60,
  maxTableRows: 30,
  maxTableColumns: 12,
  maxCellChars: 300,
  maxTitleChars: 300,
  maxTextChars: 8000
});

const LAYOUT_ALIASES = {
  title: 'title',
  cover: 'title',
  section: 'section',
  content: 'content',
  'two-column': 'twoColumn',
  twocolumn: 'twoColumn',
  two_column: 'twoColumn',
  comparison: 'twoColumn',
  'title-only': 'titleOnly',
  titleonly: 'titleOnly',
  blank: 'blank'
};

function text(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function sanitizeTable(table, warnings, slideNumber) {
  if (!table || typeof table !== 'object') return null;
  const header = (Array.isArray(table.header) ? table.header : [])
    .slice(0, DECK_LIMITS.maxTableColumns)
    .map(cell => text(String(cell ?? ''), DECK_LIMITS.maxCellChars));
  const rows = (Array.isArray(table.rows) ? table.rows : [])
    .filter(Array.isArray)
    .map(row =>
      header.map((_, i) =>
        text(
          row[i] === undefined || row[i] === null ? '' : String(row[i]),
          DECK_LIMITS.maxCellChars
        )
      )
    );
  if (!header.length) return null;
  if (rows.length > DECK_LIMITS.maxTableRows) {
    warnings.push(
      `Slide ${slideNumber}: the table was cut to ${DECK_LIMITS.maxTableRows} rows. Split long tables over several slides.`
    );
  }
  return {
    header,
    rows: rows.slice(0, DECK_LIMITS.maxTableRows),
    align: Array.isArray(table.align) ? table.align.slice(0, header.length).map(String) : []
  };
}

function sanitizeImage(image, ctx, slideNumber) {
  const src = typeof image === 'string' ? image : image?.data || image?.src;
  if (!src) return null;
  const check = checkImageDataUri(src);
  if (!check.ok) {
    ctx.warnings.push(`Slide ${slideNumber}: an image was skipped (${check.reason}).`);
    return null;
  }
  ctx.imageBytes += check.bytes;
  if (ctx.imageBytes > LIMITS.maxTotalImageBytes) {
    ctx.warnings.push(`Slide ${slideNumber}: images beyond the 15 MB budget were skipped.`);
    return null;
  }
  return {
    dataUri: check.dataUri,
    caption: typeof image === 'object' ? text(image.caption, 300) : '',
    pixels: imagePixelSize(check.dataUri) || { width: 800, height: 600 }
  };
}

function sanitizeBlock(block, ctx, slideNumber) {
  if (!block || typeof block !== 'object') return null;
  return {
    heading: text(block.heading, DECK_LIMITS.maxTitleChars),
    text: text(block.text ?? block.markdown, DECK_LIMITS.maxTextChars),
    table: sanitizeTable(block.table, ctx.warnings, slideNumber),
    chart: sanitizeChart(block.chart, ctx.warnings),
    image: sanitizeImage(block.image, ctx, slideNumber)
  };
}

/**
 * Check and normalise the slides from the model.
 *
 * @param {Array} slides
 * @param {Object} ctx - `warnings`, `imageBytes`.
 * @returns {Array<Object>}
 */
export function sanitizeSlides(slides, ctx) {
  if (!Array.isArray(slides) || !slides.length) {
    throw new Error('The presentation has no slides. Provide "slides".');
  }
  if (slides.length > DECK_LIMITS.maxSlides) {
    ctx.warnings.push(
      `Only the first ${DECK_LIMITS.maxSlides} slides were kept. Split the presentation.`
    );
  }
  return slides.slice(0, DECK_LIMITS.maxSlides).map((slide, index) => {
    const number = index + 1;
    const source = slide && typeof slide === 'object' ? slide : { text: String(slide ?? '') };
    const content = sanitizeBlock(source, ctx, number) || {};
    const left = sanitizeBlock(source.left, ctx, number);
    const right = sanitizeBlock(source.right, ctx, number);
    const requested = LAYOUT_ALIASES[String(source.layout || '').toLowerCase()];
    const hasBody = Boolean(content.text || content.table || content.chart || content.image);
    let kind = requested;
    if (!kind) {
      if (left || right) kind = 'twoColumn';
      else if (index === 0 && !hasBody) kind = 'title';
      else kind = 'content';
    }
    return {
      kind,
      title: text(source.title, DECK_LIMITS.maxTitleChars),
      subtitle: text(source.subtitle, 500),
      ...content,
      left,
      right,
      notes: text(source.notes, DECK_LIMITS.maxTextChars)
    };
  });
}

// --- Geometry ------------------------------------------------------------------

function splitHorizontally(rect, share, gap) {
  const leftWidth = Math.round((rect.cx - gap) * share);
  return [
    { ...rect, cx: leftWidth },
    { ...rect, x: rect.x + leftWidth + gap, cx: rect.cx - leftWidth - gap }
  ];
}

/** The content area of a layout, falling back to the content layout's. */
function contentArea(layout, chosen, slideSize) {
  const own = contentPlaceholders(layout)[0]?.rect;
  if (own) return own;
  const fallback = contentPlaceholders(chosen.content)[0]?.rect;
  if (fallback) return fallback;
  const title = titlePlaceholder(layout)?.rect;
  const top = title ? title.y + title.cy + slideSize.cy * 0.03 : slideSize.cy * 0.12;
  return {
    x: slideSize.cx * 0.06,
    y: top,
    cx: slideSize.cx * 0.88,
    cy: slideSize.cy * 0.88 - top
  };
}

function fitImage(pixels, rect) {
  const ratio = pixels.height / pixels.width;
  // At most twice the natural size (96 dpi), so small pictures stay sharp.
  const natural = (pixels.width / 96) * EMU_PER_INCH * 2;
  let cx = Math.min(rect.cx, natural);
  let cy = cx * ratio;
  if (cy > rect.cy) {
    cy = rect.cy;
    cx = cy / ratio;
  }
  return {
    x: Math.round(rect.x + (rect.cx - cx) / 2),
    y: Math.round(rect.y + (rect.cy - cy) / 2),
    cx: Math.round(cx),
    cy: Math.round(cy)
  };
}

/**
 * `a:bodyPr` autofit for text that may not fit its box: an estimate of the
 * lines it needs, and the font scale PowerPoint would apply.
 */
function autofit(paragraphs, rect, sizes, ctx, slideNumber) {
  if (!rect) return '<a:normAutofit/>';
  const width = rect.cx - 0.2 * EMU_PER_INCH;
  let height = 0;
  for (const paragraph of paragraphs) {
    const size = (sizes[Math.min(paragraph.level || 0, sizes.length - 1)] || 2000) / 100;
    const chars = paragraph.runs.reduce((n, r) => n + r.text.length, 0) || 1;
    const indent = (paragraph.level || 0) * 0.4 * EMU_PER_INCH + 0.3 * EMU_PER_INCH;
    const charWidth = size * 0.5 * 12700;
    const lines = Math.max(1, Math.ceil((chars * charWidth) / Math.max(1, width - indent)));
    height += lines * size * 1.2 * 12700 + size * 0.5 * 12700;
  }
  const available = rect.cy - 0.1 * EMU_PER_INCH;
  if (height <= available) return '<a:normAutofit/>';
  const scale = Math.max(0.4, available / height);
  const fontScale = Math.max(40000, Math.floor((scale * 100000) / 2500) * 2500);
  if (scale < 0.6) {
    ctx.warnings.push(
      `Slide ${slideNumber}: the text is too long for the slide and was shrunk to ${Math.round(scale * 100)} %. Split it over two slides or shorten it.`
    );
  }
  return `<a:normAutofit fontScale="${fontScale}" lnSpcReduction="${scale < 0.8 ? 20000 : 10000}"/>`;
}

function tableLayout(table, rect) {
  const columns = table.header.length;
  const lengths = table.header.map((cell, i) =>
    Math.max(String(cell).length, ...table.rows.map(row => String(row[i] ?? '').length))
  );
  const weights = lengths.map(len => Math.sqrt(Math.min(Math.max(len, 3), 80)));
  const sum = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map(w => Math.floor((rect.cx * w) / sum));
  let fontSize = 16;
  for (; fontSize > 9; fontSize -= 1) {
    const lineHeight = fontSize * 1.25 * 12700;
    let total = 0;
    for (const row of [table.header, ...table.rows]) {
      let lines = 1;
      row.forEach((cell, i) => {
        const charWidth = fontSize * 0.52 * 12700;
        const width = Math.max(1, widths[i] - 182880);
        lines = Math.max(lines, Math.ceil((String(cell ?? '').length * charWidth) / width) || 1);
      });
      total += lines * lineHeight + 91440;
    }
    if (total <= rect.cy) break;
  }
  return {
    columnWidths: widths,
    fontSize,
    rowHeight: Math.round(fontSize * 1.25 * 12700 + 91440),
    columns
  };
}

// --- Slide assembly ------------------------------------------------------------

class SlideBuilder {
  constructor({ number, layout, ctx }) {
    this.number = number;
    this.layout = layout;
    this.ctx = ctx;
    this.nextId = 2;
    this.shapes = [];
    this.rels = [];
    this.charts = [];
  }

  id() {
    const id = this.nextId;
    this.nextId += 1;
    return id;
  }

  rel(type, target, external = false) {
    const existing = this.rels.find(r => r.type === type && r.target === target);
    if (existing) return existing.id;
    const id = `rId${this.rels.length + 2}`;
    this.rels.push({ id, type, target, external });
    return id;
  }

  linkId = url => this.rel(REL_TYPES.hyperlink, url, true);

  textXml(paragraphs, options = {}) {
    return paragraphsXml(paragraphs, { lang: this.ctx.lang, linkId: this.linkId, ...options });
  }

  placeholder(ph, paragraphs, { rect, bullets = true, sizes } = {}) {
    const box = rect || ph.rect;
    const bodyPr = autofit(
      paragraphs,
      box,
      sizes || (bullets ? this.ctx.bodySizes(ph) : [this.ctx.titleSize(ph)]),
      this.ctx,
      this.number
    );
    this.shapes.push(
      placeholderShape({
        id: this.id(),
        name: `${ph.type === 'title' || ph.type === 'ctrTitle' ? 'Title' : 'Content'} ${this.nextId}`,
        ph,
        body: this.textXml(paragraphs, { bullets }),
        rect,
        bodyPr
      })
    );
  }

  /**
   * A text box, for text no placeholder of the layout can take: list items
   * get bullets of their own, sized like the template's body text.
   */
  textBox(rect, paragraphs, options = {}) {
    const sizes = options.rPr?.sz ? [options.rPr.sz] : this.ctx.bodySizes(null);
    this.shapes.push(
      textBoxShape({
        id: this.id(),
        name: `Text ${this.nextId}`,
        rect,
        body: this.textXml(paragraphs, { bullets: 'explicit', sizes, ...options }),
        bodyPr: autofit(paragraphs, rect, sizes, this.ctx, this.number)
      })
    );
  }

  picture(image, rect) {
    const index = (this.ctx.mediaCount += 1);
    const ext = image.dataUri.startsWith('data:image/png') ? 'png' : 'jpeg';
    const path = `ppt/media/ihub-image-${index}.${ext}`;
    this.ctx.zip.file(
      path,
      Buffer.from(image.dataUri.slice(image.dataUri.indexOf(',') + 1), 'base64')
    );
    this.ctx.types.ensureDefault(ext, IMAGE_CONTENT_TYPES[ext]);
    const relId = this.rel(REL_TYPES.image, `../media/ihub-image-${index}.${ext}`);
    let area = rect;
    if (image.caption) {
      const captionHeight = 0.4 * EMU_PER_INCH;
      area = { ...rect, cy: Math.max(1, rect.cy - captionHeight) };
      this.textBox(
        { x: rect.x, y: rect.y + rect.cy - captionHeight, cx: rect.cx, cy: captionHeight },
        [{ runs: [{ text: image.caption, italic: true }] }],
        { align: 'ctr', rPr: { sz: 1200 } }
      );
    }
    this.shapes.push(
      pictureShape({
        id: this.id(),
        name: `Picture ${this.nextId}`,
        rect: fitImage(image.pixels, area),
        relId,
        description: image.caption
      })
    );
  }

  table(table, rect) {
    const layout = tableLayout(table, rect);
    this.shapes.push(
      tableFrame({
        id: this.id(),
        rect,
        table,
        lang: this.ctx.lang,
        accent: this.ctx.accent,
        ...layout
      })
    );
  }

  chart(chart, rect) {
    const request = this.ctx.charts.length;
    this.ctx.charts.push({ chart, rect, slide: this });
    const id = this.id();
    this.charts.push({ request, id });
    this.shapes.push(`<!--ihub-chart-${request}-->`);
  }

  /** One block of content (text and/or a visual) in a rectangle. */
  block(block, rect, { ph } = {}) {
    if (!block) return;
    const { paragraphs, table: markdownTable } = markdownToSlideText(block.text);
    const table = block.table || markdownTable;
    const visual = block.chart ? 'chart' : table ? 'table' : block.image ? 'image' : null;
    if (block.heading) {
      paragraphs.unshift({ runs: [{ text: block.heading, bold: true }], heading: true });
    }
    let visualRect = rect;
    if (paragraphs.length && visual) {
      // Text beside the visual: a third of the width for short text, more
      // for longer text.
      const share = textLength(paragraphs) > 300 ? 0.45 : 0.36;
      const [textRect, otherRect] = splitHorizontally(rect, share, 0.3 * EMU_PER_INCH);
      if (ph) this.placeholder(ph, paragraphs, { rect: textRect });
      else this.textBox(textRect, paragraphs);
      visualRect = otherRect;
    } else if (paragraphs.length) {
      if (ph) this.placeholder(ph, paragraphs, { rect: ph.rect === rect ? undefined : rect });
      else this.textBox(rect, paragraphs);
      return;
    }
    if (visual === 'chart') this.chart(block.chart, visualRect);
    else if (visual === 'table') this.table(table, visualRect);
    else if (visual === 'image') this.picture(block.image, visualRect);
  }

  footer(spec) {
    const footer = this.layout.placeholders.find(ph => ph.type === 'ftr');
    if (footer && spec.footer) {
      this.shapes.push(
        placeholderShape({
          id: this.id(),
          name: 'Footer',
          ph: footer,
          body: this.textXml([{ runs: [{ text: spec.footer }] }], { bullets: false })
        })
      );
    }
    const number = this.layout.placeholders.find(ph => ph.type === 'sldNum');
    if (number && spec.slideNumbers !== false) {
      this.shapes.push(
        placeholderShape({
          id: this.id(),
          name: 'Slide Number',
          ph: number,
          body: `<a:p><a:fld id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="slidenum"><a:rPr lang="${xmlEscape(this.ctx.lang)}"/><a:t>${this.number}</a:t></a:fld><a:endParaRPr lang="${xmlEscape(this.ctx.lang)}"/></a:p>`
        })
      );
    }
  }
}

function plainParagraphs(value) {
  return value ? [{ runs: [{ text: value }] }] : [];
}

function buildSlide(slide, number, ctx, spec) {
  const layout = ctx.layouts[slide.kind] || ctx.layouts.content;
  const builder = new SlideBuilder({ number, layout, ctx });
  const title = titlePlaceholder(layout);
  const contents = contentPlaceholders(layout).sort((a, b) => a.rect.x - b.rect.x);
  // Text only goes into placeholders made for text (not picture or media ones).
  const textPlaceholders = contents.filter(ph => ph.type === 'obj' || ph.type === 'body');
  const subtitlePh =
    layout.placeholders.find(ph => ph.type === 'subTitle') ||
    (slide.kind === 'title' || slide.kind === 'section' ? textPlaceholders[0] : null);

  if (slide.title) {
    if (title) builder.placeholder(title, plainParagraphs(slide.title), { bullets: false });
    else {
      const area = contentArea(layout, ctx.layouts, ctx.slideSize);
      builder.textBox(
        {
          x: area.x,
          y: Math.max(0, area.y - 0.9 * EMU_PER_INCH),
          cx: area.cx,
          cy: 0.8 * EMU_PER_INCH
        },
        plainParagraphs(slide.title),
        { rPr: { sz: 2800, bold: true } }
      );
    }
  }

  if (slide.kind === 'title' || slide.kind === 'section') {
    const subtitle =
      slide.subtitle || (slide.text && !slide.table && !slide.chart ? slide.text : '');
    if (subtitle && subtitlePh) {
      const { paragraphs } = markdownToSlideText(subtitle);
      builder.placeholder(subtitlePh, paragraphs, {
        bullets: false,
        sizes: ctx.bodySizes(subtitlePh)
      });
    }
  } else if (slide.kind === 'twoColumn') {
    const left = slide.left || {
      text: slide.text,
      table: slide.table,
      chart: slide.chart,
      image: slide.image
    };
    const right = slide.right;
    let rects;
    let phs = [null, null];
    if (textPlaceholders.length >= 2) {
      rects = [textPlaceholders[0].rect, textPlaceholders[1].rect];
      phs = [textPlaceholders[0], textPlaceholders[1]];
    } else {
      // Both columns as text boxes, so they look alike.
      rects = splitHorizontally(
        contentArea(layout, ctx.layouts, ctx.slideSize),
        0.5,
        0.4 * EMU_PER_INCH
      );
    }
    builder.block(left, rects[0], { ph: phs[0] });
    builder.block(right, rects[1], { ph: phs[1] });
  } else if (slide.kind !== 'blank' || slide.text || slide.table || slide.chart || slide.image) {
    const area = contentArea(layout, ctx.layouts, ctx.slideSize);
    const ph = textPlaceholders.find(p => p.rect === area) || null;
    builder.block(slide, area, { ph });
  }

  if (slide.kind !== 'title') builder.footer(spec);
  return builder;
}

function notesSlideXml(notes, lang) {
  const paragraphs = notes
    .split(/\n+/)
    .filter(line => line.trim())
    .map(
      line =>
        `<a:p><a:r><a:rPr lang="${xmlEscape(lang)}" dirty="0"/><a:t>${xmlEscape(line)}</a:t></a:r></a:p>`
    )
    .join('');
  return `${XML_HEAD}<p:notes ${PML_NAMESPACES}><p:cSld><p:spTree>${GROUP_PROPS}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs || '<a:p><a:endParaRPr lang="en-US"/></a:p>'}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;
}

function uniquePath(zip, pattern) {
  for (let n = 1; ; n += 1) {
    const path = pattern.replace('{n}', String(n));
    if (!zip.file(path)) return path;
  }
}

/** Remove the slides a template file came with (and what lists them). */
async function removeTemplateSlides(template) {
  const { zip, presentation } = template;
  const root = presentation.documentElement;
  const list = firstChild(root, 'sldIdLst');
  const removed = new Set();
  for (const slideId of childElements(list, 'sldId')) {
    const relId = slideId.getAttributeNS(NS.r, 'id');
    const rel = template.presRels.find(r => r.id === relId);
    if (rel) {
      const path = resolveTarget(PRESENTATION, rel.target);
      for (const slideRel of await readRels(zip, path)) {
        if (slideRel.type === REL_TYPES.notesSlide) {
          const notesPath = resolveTarget(path, slideRel.target);
          zip.remove(notesPath);
          zip.remove(notesPath.replace(/([^/]+)$/, '_rels/$1.rels'));
        }
      }
      zip.remove(path);
      zip.remove(path.replace(/([^/]+)$/, '_rels/$1.rels'));
      removed.add(relId);
    }
  }
  if (list) root.removeChild(list);
  template.presRels = template.presRels.filter(r => !removed.has(r.id));
  // Custom shows and sections list slides by id.
  const shows = firstChild(root, 'custShowLst');
  if (shows) root.removeChild(shows);
  for (const ext of descendants(firstChild(root, 'extLst'), 'ext')) {
    if (descendants(ext, 'sectionLst').length) ext.parentNode.removeChild(ext);
  }
}

/** Insert an element into `p:presentation` at its schema position. */
function insertPresentationChild(root, element, after) {
  let anchor = null;
  for (const name of after) {
    const found = childElements(root, name).at(-1);
    if (found) anchor = found;
  }
  if (anchor) root.insertBefore(element, anchor.nextSibling);
  else root.insertBefore(element, root.firstChild);
}

/**
 * Build the presentation.
 *
 * @param {Object} spec - `title`, `author`, `language`, `slides`, `footer`,
 *   `slideNumbers`.
 * @param {Object} options
 * @param {Buffer} options.template - The template package (`.pptx`/`.potx`).
 * @param {Object} [options.layouts] - Layout names by kind (admin's choice).
 * @returns {Promise<{ buffer: Buffer, slides: number, warnings: string[] }>}
 */
export async function buildPptx(spec, { template: templateBuffer, layouts: overrides } = {}) {
  const warnings = [];
  const slides = sanitizeSlides(spec.slides, { warnings, imageBytes: 0 });
  const template = await loadPresentationTemplate(templateBuffer);
  const { zip } = template;
  const types = await ContentTypes.read(zip);
  types.setOverride(PRESENTATION, PRESENTATION_TYPE);
  await removeTemplateSlides(template);

  const master = template.masters[0];
  const theme = master?.theme || { colors: {}, fonts: {} };
  const accents = ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6']
    .map(key => theme.colors[key])
    .filter(Boolean);
  const lang =
    typeof spec.language === 'string' && spec.language ? spec.language.slice(0, 10) : 'en-US';
  const ctx = {
    zip,
    types,
    lang,
    warnings,
    imageBytes: 0,
    mediaCount: 0,
    charts: [],
    slideSize: template.slideSize,
    accent: theme.colors.accent1 || '1E3A8A',
    layouts: chooseLayouts(template.layouts, overrides),
    bodySizes: ph => {
      const sizes = master?.bodySizes || [2000, 1800, 1600];
      return ph?.size ? [ph.size, ...sizes.slice(1)] : sizes;
    },
    titleSize: ph => ph?.size || master?.titleSize || 3200
  };

  const builders = slides.map((slide, index) => buildSlide(slide, index + 1, ctx, spec));

  // Charts are rendered together, then moved onto their slides.
  const rendered = await renderCharts(
    ctx.charts.map(({ chart, rect }) => ({ chart, rect })),
    {
      slideSize: template.slideSize,
      colors: accents.length ? accents : ['1E3A8A', '0F766E', 'F59E0B', '10B981'],
      font: theme.fonts.minor || 'Calibri'
    }
  );
  rendered.forEach((part, index) => {
    const builder = ctx.charts[index].slide;
    const chartPath = uniquePath(zip, 'ppt/charts/chart{n}.xml');
    zip.file(chartPath, part.chartXml);
    types.setOverride(chartPath, CHART_TYPE);
    if (part.workbook) {
      const workbookPath = uniquePath(zip, 'ppt/embeddings/ihub-chart-{n}.xlsx');
      zip.file(workbookPath, part.workbook);
      types.ensureDefault('xlsx', XLSX_TYPE);
      const relId = /<c:externalData r:id="([^"]+)"/.exec(part.chartXml)?.[1] || 'rId1';
      writeRels(zip, chartPath, [
        { id: relId, type: REL_TYPES.package, target: relativeTarget(chartPath, workbookPath) }
      ]);
    }
    const relId = builder.rel(REL_TYPES.chart, `../charts/${chartPath.split('/').pop()}`);
    const { id } = builder.charts.find(c => c.request === index);
    const frame = part.frameXml
      .replace(/<p:cNvPr id="\d+"/, `<p:cNvPr id="${id}"`)
      .replace(/(<c:chart\b[^>]*\br:id=")[^"]+"/, `$1${relId}"`);
    builder.shapes = builder.shapes.map(shape =>
      shape === `<!--ihub-chart-${index}-->` ? frame : shape
    );
  });

  // Speaker notes need a notes master.
  let notesMaster = template.notesMaster;
  const presRoot = template.presentation.documentElement;
  if (!notesMaster && builders.some((_, i) => slides[i].notes)) {
    const themePath = uniquePath(zip, 'ppt/theme/theme{n}.xml');
    notesMaster = addNotesMaster(zip, { themePath });
    types.setOverride(notesMaster, NOTES_MASTER_TYPE);
    types.setOverride(themePath, THEME_TYPE);
    const relId = nextRelId(template.presRels);
    template.presRels.push({
      id: relId,
      type: REL_TYPES.notesMaster,
      target: relativeTarget(PRESENTATION, notesMaster)
    });
    const list = template.presentation.createElementNS(NS.p, 'p:notesMasterIdLst');
    const entry = template.presentation.createElementNS(NS.p, 'p:notesMasterId');
    entry.setAttributeNS(NS.r, 'r:id', relId);
    list.appendChild(entry);
    insertPresentationChild(presRoot, list, ['sldMasterIdLst']);
  }

  const slideList = template.presentation.createElementNS(NS.p, 'p:sldIdLst');
  builders.forEach((builder, index) => {
    const number = index + 1;
    const slidePath = uniquePath(zip, 'ppt/slides/slide{n}.xml');
    const layoutRel = {
      id: 'rId1',
      type: REL_TYPES.slideLayout,
      target: relativeTarget(slidePath, builder.layout.path)
    };
    const rels = [layoutRel, ...builder.rels];
    const notes = slides[index].notes;
    if (notes && notesMaster) {
      const notesPath = uniquePath(zip, 'ppt/notesSlides/notesSlide{n}.xml');
      zip.file(notesPath, notesSlideXml(notes, ctx.lang));
      writeRels(zip, notesPath, [
        { id: 'rId1', type: REL_TYPES.notesMaster, target: relativeTarget(notesPath, notesMaster) },
        { id: 'rId2', type: REL_TYPES.slide, target: relativeTarget(notesPath, slidePath) }
      ]);
      types.setOverride(notesPath, NOTES_TYPE);
      rels.push({
        id: nextRelId(rels),
        type: REL_TYPES.notesSlide,
        target: relativeTarget(slidePath, notesPath)
      });
    }
    zip.file(
      slidePath,
      `${XML_HEAD}<p:sld ${PML_NAMESPACES}><p:cSld><p:spTree>${GROUP_PROPS}${builder.shapes.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
    );
    writeRels(zip, slidePath, rels);
    types.setOverride(slidePath, SLIDE_TYPE);
    const relId = nextRelId(template.presRels);
    template.presRels.push({
      id: relId,
      type: REL_TYPES.slide,
      target: relativeTarget(PRESENTATION, slidePath)
    });
    const entry = template.presentation.createElementNS(NS.p, 'p:sldId');
    entry.setAttribute('id', String(255 + number));
    entry.setAttributeNS(NS.r, 'r:id', relId);
    slideList.appendChild(entry);
  });
  insertPresentationChild(presRoot, slideList, [
    'sldMasterIdLst',
    'notesMasterIdLst',
    'handoutMasterIdLst'
  ]);
  writeXmlPart(zip, PRESENTATION, template.presentation);
  writeRels(zip, PRESENTATION, template.presRels);

  zip.file(
    'docProps/app.xml',
    `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>iHub Apps</Application><Slides>${builders.length}</Slides></Properties>`
  );
  await setCoreProperties(zip, types, {
    title: spec.title,
    author: spec.author,
    subject: spec.subtitle,
    language: spec.language
  });
  await removeUnreachableParts(zip, types);
  types.write(zip);
  return { buffer: await writePackage(zip), slides: builders.length, warnings };
}
