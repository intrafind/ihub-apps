// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { Lexer } from 'marked';
import {
  ContentTypes,
  IMAGE_CONTENT_TYPES,
  INVALID_XML_CHARS,
  NS,
  REL_TYPES,
  childElements,
  descendants,
  firstChild,
  nextRelId,
  readRels,
  relativeTarget,
  relsPathOf,
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
  CONVENTIONAL_SLOTS,
  chooseLayoutForSlots,
  chooseLayouts,
  contentPlaceholders,
  layoutSlotIds,
  loadPresentationTemplate,
  slotPlaceholder,
  titlePlaceholder
} from './pptxTemplate.js';
import { MAX_SLOTS, SLOT_ID_PATTERN } from './slotIds.js';
import {
  EMU_PER_INCH,
  GROUP_PROPS,
  inlineRuns,
  PML_NAMESPACES,
  XML_HEAD,
  markdownToSlideText,
  metricCards,
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
 * @property {Object<string, string>} [slots] - Text by slot id (`kicker`, `lead` …) for the
 *   text slots the template's layouts have besides title and content. A slot the layout of
 *   the slide does not have is left out, or becomes the first paragraph of the text, as the
 *   slot's `ifMissing` says.
 * @property {string} [footer] - Text of the footer strip of a title slide (and, on other
 *   slides, in place of the deck's footer).
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
export const PRESENTATION_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';
const PRESENTATION = 'ppt/presentation.xml';

export const DECK_LIMITS = Object.freeze({
  maxSlides: 60,
  maxTableRows: 30,
  maxTableColumns: 12,
  maxCellChars: 300,
  maxTitleChars: 300,
  maxSlotChars: 300,
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

function sanitizeMetrics(metrics) {
  if (!Array.isArray(metrics)) return null;
  const clean = (val, max) =>
    typeof val === 'string' || typeof val === 'number'
      ? String(val).replace(INVALID_XML_CHARS, '').trim().slice(0, max)
      : '';
  const items = metrics
    .filter(m => m && typeof m === 'object')
    .map(m => ({
      value: clean(m.value, 40),
      label: clean(m.label, 80),
      note: clean(m.note ?? m.change ?? m.subtitle, 100)
    }))
    .filter(m => m.value && m.label)
    .slice(0, 4);
  return items.length ? items : null;
}

/** Text by slot id: valid ids with text, at most {@link MAX_SLOTS}. */
function sanitizeSlots(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [id, raw] of Object.entries(value).slice(0, MAX_SLOTS)) {
    if (!SLOT_ID_PATTERN.test(id) || typeof raw !== 'string') continue;
    const clean = raw.replace(INVALID_XML_CHARS, '').trim().slice(0, DECK_LIMITS.maxSlotChars);
    if (clean) out[id] = clean;
  }
  return out;
}

function sanitizeBlock(block, ctx, slideNumber) {
  if (!block || typeof block !== 'object') return null;
  return {
    heading: text(block.heading, DECK_LIMITS.maxTitleChars),
    text: text(block.text ?? block.markdown, DECK_LIMITS.maxTextChars),
    metrics: sanitizeMetrics(block.metrics),
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
    const hasBody = Boolean(
      content.text || content.metrics || content.table || content.chart || content.image
    );
    let kind = requested;
    if (!kind) {
      if (left || right) kind = 'twoColumn';
      else if (index === 0 && !hasBody) kind = 'title';
      else kind = 'content';
    }
    return {
      kind,
      title: text(source.title, DECK_LIMITS.maxTitleChars),
      slots: sanitizeSlots(source.slots),
      footer: text(source.footer, 200),
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
export function contentArea(layout, chosen, slideSize) {
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
 *
 * @param {Array} paragraphs
 * @param {Object|null} rect
 * @param {number[]} sizes - Font size per level (hundredths of a point).
 * @param {Object} ctx
 * @param {number} slideNumber
 * @param {Object} [options]
 * @param {boolean} [options.compact] - A box without insets, list indents and
 *   paragraph spacing (a text slot of a slide), so none is assumed.
 */
function autofit(paragraphs, rect, sizes, ctx, slideNumber, { compact = false } = {}) {
  if (!rect) return '<a:normAutofit/>';
  const pad = compact ? 0 : 0.1 * EMU_PER_INCH;
  const width = rect.cx - 2 * pad;
  let height = 0;
  for (const paragraph of paragraphs) {
    const size = (sizes[Math.min(paragraph.level || 0, sizes.length - 1)] || 2000) / 100;
    const chars = paragraph.runs.reduce((n, r) => n + r.text.length, 0) || 1;
    const indent = compact ? 0 : (paragraph.level || 0) * 0.4 * EMU_PER_INCH + 0.3 * EMU_PER_INCH;
    const charWidth = size * 0.5 * 12700;
    const lines = Math.max(1, Math.ceil((chars * charWidth) / Math.max(1, width - indent)));
    height += lines * size * 1.2 * 12700 + (compact ? 0 : size * 0.5 * 12700);
  }
  const available = rect.cy - pad;
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

  placeholder(ph, paragraphs, { rect, bullets = true, sizes, name, compact = false } = {}) {
    const box = rect || ph.rect;
    const bodyPr = autofit(
      paragraphs,
      box,
      sizes || (bullets ? this.ctx.bodySizes(ph) : [this.ctx.titleSize(ph)]),
      this.ctx,
      this.number,
      { compact }
    );
    this.shapes.push(
      placeholderShape({
        id: this.id(),
        name:
          name ||
          `${ph.type === 'title' || ph.type === 'ctrTitle' ? 'Title' : 'Content'} ${this.nextId}`,
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

  metrics(metrics, rect) {
    this.shapes.push(
      ...metricCards({
        nextId: () => this.id(),
        rect,
        metrics,
        lang: this.ctx.lang,
        colors: this.ctx.themeColors
      })
    );
  }

  /** One block of content (text, KPI metrics and/or a visual) in a rectangle. */
  block(block, rect, { ph } = {}) {
    if (!block) return;
    const { paragraphs, table: markdownTable } = markdownToSlideText(block.text);
    // A GFM table in the text gets the same limits as a `table` field.
    const table = block.table || sanitizeTable(markdownTable, this.ctx.warnings, this.number);
    const visual = block.chart ? 'chart' : table ? 'table' : block.image ? 'image' : null;
    if (block.heading) {
      paragraphs.unshift({ runs: [{ text: block.heading, bold: true }], heading: true });
    }
    let bodyRect = rect;
    if (block.metrics?.length) {
      if (!paragraphs.length && !visual) {
        this.metrics(block.metrics, rect);
        return;
      }
      const bandHeight = Math.min(Math.round(1.35 * EMU_PER_INCH), Math.round(rect.cy * 0.34));
      const gap = Math.round(0.2 * EMU_PER_INCH);
      this.metrics(block.metrics, { x: rect.x, y: rect.y, cx: rect.cx, cy: bandHeight });
      bodyRect = {
        x: rect.x,
        y: rect.y + bandHeight + gap,
        cx: rect.cx,
        cy: Math.max(1, rect.cy - bandHeight - gap)
      };
    }
    let visualRect = bodyRect;
    if (paragraphs.length && visual) {
      // Text beside the visual: a third of the width for short text, more
      // for longer text.
      const share = textLength(paragraphs) > 300 ? 0.45 : 0.36;
      const [textRect, otherRect] = splitHorizontally(bodyRect, share, 0.3 * EMU_PER_INCH);
      if (ph) this.placeholder(ph, paragraphs, { rect: textRect });
      else this.textBox(textRect, paragraphs);
      visualRect = otherRect;
    } else if (paragraphs.length) {
      if (ph)
        this.placeholder(ph, paragraphs, { rect: ph.rect === bodyRect ? undefined : bodyRect });
      else this.textBox(bodyRect, paragraphs);
      return;
    }
    if (visual === 'chart') this.chart(block.chart, visualRect);
    else if (visual === 'table') this.table(table, visualRect);
    else if (visual === 'image') this.picture(block.image, visualRect);
  }

  /**
   * The footer strip of a title slide. Only a layout whose footer placeholder is
   * meant for it takes part: the deck's footer text is for the other slides, so
   * the strip shows the slide's own `footer`, else the text the layout has in it.
   */
  titleStrip(text) {
    const strip = this.layout.placeholders.find(ph => ph.type === 'ftr' && ph.rect);
    const value = text || strip?.text;
    if (!strip || !value) return;
    this.shapes.push(
      placeholderShape({
        id: this.id(),
        name: 'Footer',
        ph: strip,
        body: this.textXml([{ runs: [{ text: value }] }], { bullets: false })
      })
    );
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

/**
 * The layout of a slide: the layout of its kind, or — for a slide that fills
 * text slots — the template's layout of that kind that has most of them.
 */
function layoutFor(slide, ctx) {
  const base = ctx.layouts[slide.kind] || ctx.layouts.content;
  return chooseLayoutForSlots(ctx.allLayouts, slide.kind, base, Object.keys(slide.slots));
}

/**
 * The text of slots the layout has no placeholder for, where the slot says so
 * (`ifMissing: 'text'`): the first paragraph of the slide's text (of the left
 * column of a two-column slide), or the subtitle of a title or section slide.
 * A title-only or blank slide has no text to put it in.
 */
function withSlotText(slide, texts) {
  if (!texts.length) return slide;
  const join = value => [...texts, value].filter(Boolean).join('\n\n');
  if (slide.kind === 'twoColumn' && slide.left) {
    return { ...slide, left: { ...slide.left, text: join(slide.left.text) } };
  }
  if (slide.kind === 'content' || slide.kind === 'twoColumn') {
    return { ...slide, text: join(slide.text) };
  }
  if ((slide.kind === 'title' || slide.kind === 'section') && !slide.subtitle) {
    return { ...slide, subtitle: texts.join(' ') };
  }
  return slide;
}

/** Slot text as inline Markdown (bold, links), on one line. */
function slotParagraphs(value) {
  const line = value.replace(/\s*\n\s*/g, ' ');
  return [{ runs: inlineRuns(new Lexer({ gfm: true }).inlineTokens(line)) }];
}

function buildSlide(source, number, ctx, spec) {
  const layout = layoutFor(source, ctx);
  // Slots the layout has go into their placeholders; the others follow the slot's rule.
  const filled = [];
  const fallback = [];
  for (const [id, value] of Object.entries(source.slots)) {
    if (!ctx.slotIds.has(id)) {
      ctx.warnings.push(
        `Slide ${number}: the template has no slot "${id}"; its text was left out. Slots: ${[...ctx.slotIds].join(', ')}.`
      );
      continue;
    }
    const ph = slotPlaceholder(layout, id);
    if (ph) filled.push({ id, ph, value });
    else if (ctx.slotRules[id] === 'text') fallback.push(value);
  }
  const slide = withSlotText(source, fallback);
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

  for (const { id, ph, value } of filled) {
    builder.placeholder(ph, slotParagraphs(value), {
      bullets: false,
      sizes: [ph.size || ctx.bodySizes(ph)[0]],
      name: ph.name || id,
      compact: true
    });
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
      metrics: slide.metrics,
      table: slide.table,
      chart: slide.chart,
      image: slide.image
    };
    const right = slide.right;
    let rects;
    let phs = [null, null];
    // The two largest text placeholders, left to right — not a heading box
    // stacked over a content box (as in "Comparison" layouts).
    const columns = [...textPlaceholders]
      .sort((a, b) => b.rect.cx * b.rect.cy - a.rect.cx * a.rect.cy)
      .slice(0, 2)
      .sort((a, b) => a.rect.x - b.rect.x);
    const sideBySide =
      columns.length === 2 && columns[0].rect.x + columns[0].rect.cx <= columns[1].rect.x;
    if (sideBySide) {
      rects = [columns[0].rect, columns[1].rect];
      phs = columns;
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
  } else if (
    slide.kind !== 'blank' ||
    slide.text ||
    slide.metrics ||
    slide.table ||
    slide.chart ||
    slide.image
  ) {
    const area = contentArea(layout, ctx.layouts, ctx.slideSize);
    const ph = textPlaceholders.find(p => p.rect === area) || null;
    builder.block(slide, area, { ph });
  }

  if (slide.kind === 'title') builder.titleStrip(slide.footer);
  else builder.footer({ ...spec, footer: slide.footer || spec.footer });
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

export function uniquePath(zip, pattern) {
  for (let n = 1; ; n += 1) {
    const path = pattern.replace('{n}', String(n));
    if (!zip.file(path)) return path;
  }
}

/** Remove the slides a template file came with (and what lists them). */
export async function removeTemplateSlides(template) {
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
          zip.remove(relsPathOf(notesPath));
        }
      }
      zip.remove(path);
      zip.remove(relsPathOf(path));
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
export function insertPresentationChild(root, element, after) {
  let anchor = null;
  for (const name of after) {
    const found = childElements(root, name).at(-1);
    if (found) anchor = found;
  }
  if (anchor) root.insertBefore(element, anchor.nextSibling);
  else root.insertBefore(element, root.firstChild);
}

/**
 * The template's notes master; a template without one gets a plain one.
 *
 * @param {Object} template - From `loadPresentationTemplate`.
 * @param {import('../ooxml/opcPackage.js').ContentTypes} types
 * @returns {string} The notes master's part path.
 */
export function ensureNotesMaster(template, types) {
  if (template.notesMaster) return template.notesMaster;
  const { zip } = template;
  const themePath = uniquePath(zip, 'ppt/theme/theme{n}.xml');
  const notesMaster = addNotesMaster(zip, { themePath });
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
  insertPresentationChild(template.presentation.documentElement, list, ['sldMasterIdLst']);
  template.notesMaster = notesMaster;
  return notesMaster;
}

/**
 * What a template's slots are: their ids (declared ones, the ones its layouts
 * have, and the conventional `kicker` and `lead`) and what happens to a slot's
 * text when the slide's layout has no placeholder for it.
 */
function slotRulesOf(layouts, declared = {}) {
  const slotRules = {};
  for (const [id, conventional] of Object.entries(CONVENTIONAL_SLOTS)) {
    slotRules[id] = conventional.ifMissing;
  }
  for (const [id, slot] of Object.entries(declared || {})) {
    slotRules[id] = slot.ifMissing || CONVENTIONAL_SLOTS[id]?.ifMissing || 'drop';
  }
  for (const layout of layouts) {
    for (const id of layoutSlotIds(layout)) slotRules[id] ||= 'drop';
  }
  return { slotRules, slotIds: new Set(Object.keys(slotRules)) };
}

/**
 * Build the presentation.
 *
 * @param {Object} spec - `title`, `author`, `language`, `slides`, `footer`,
 *   `slideNumbers`.
 * @param {Object} options
 * @param {Buffer} options.template - The template package (`.pptx`/`.potx`).
 * @param {Object} [options.layouts] - Layout names by kind (admin's choice).
 * @param {Object} [options.slots] - The slots the document template declares (`pptx.slots`).
 * @param {boolean} [options.keepTemplateSlides] - Keep the slides the template
 *   file already has and add the new ones after them (`append`); by default
 *   they are removed and only the master and layouts are used.
 * @returns {Promise<{ buffer: Buffer, slides: number, warnings: string[] }>}
 */
export async function buildPptx(
  spec,
  { template: templateBuffer, layouts: overrides, keepTemplateSlides = false, slots } = {}
) {
  const warnings = [];
  const slides = sanitizeSlides(spec.slides, { warnings, imageBytes: 0 });
  const template = await loadPresentationTemplate(templateBuffer, { slots });
  const { zip } = template;
  const types = await ContentTypes.read(zip);
  types.setOverride(PRESENTATION, PRESENTATION_TYPE);
  if (!keepTemplateSlides) await removeTemplateSlides(template);

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
    themeColors: theme.colors,
    layouts: chooseLayouts(template.layouts, overrides),
    allLayouts: template.layouts,
    ...slotRulesOf(template.layouts, slots),
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
  const presRoot = template.presentation.documentElement;
  const notesMaster = builders.some((_, i) => slides[i].notes)
    ? ensureNotesMaster(template, types)
    : template.notesMaster;

  const existingList = keepTemplateSlides ? firstChild(presRoot, 'sldIdLst') : null;
  const slideList = existingList || template.presentation.createElementNS(NS.p, 'p:sldIdLst');
  let nextSlideId = 255;
  for (const entry of childElements(existingList, 'sldId')) {
    nextSlideId = Math.max(nextSlideId, Number(entry.getAttribute('id')) || 0);
  }
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
    entry.setAttribute('id', String(nextSlideId + number));
    entry.setAttributeNS(NS.r, 'r:id', relId);
    slideList.appendChild(entry);
  });
  if (!existingList) {
    insertPresentationChild(presRoot, slideList, [
      'sldMasterIdLst',
      'notesMasterIdLst',
      'handoutMasterIdLst'
    ]);
  }
  writeXmlPart(zip, PRESENTATION, template.presentation);
  writeRels(zip, PRESENTATION, template.presRels);

  zip.file(
    'docProps/app.xml',
    `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>iHub Apps</Application><Slides>${childElements(slideList, 'sldId').length}</Slides></Properties>`
  );
  await setCoreProperties(zip, types, {
    title: spec.title,
    author: spec.author,
    subject: spec.subtitle,
    language: spec.language
  });
  await removeUnreachableParts(zip, types);
  types.write(zip);
  const totalSlides = childElements(slideList, 'sldId').length;
  return { buffer: await writePackage(zip), slides: totalSlides, warnings };
}
