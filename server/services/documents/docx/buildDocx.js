// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  ImageRun,
  LevelFormat,
  Packer,
  PageBreak,
  PageNumber,
  PageOrientation,
  Paragraph,
  ShadingType,
  TabStopType,
  TableOfContents,
  TextRun
} from 'docx';
import { officeFontName } from '../officeFonts.js';
import { isColor } from '../pdf/themes.js';
import { checkImageDataUri, clampNumber, imagePixelSize } from '../pdf/validators.js';
import { markdownToDocx, NUMBERING, STYLE_IDS, hex } from './markdownToDocx.js';

/**
 * Build a Word document from a document spec.
 *
 * Without a Word template the document carries its own styles, made from the
 * template's brand (colours, fonts) or iHub's defaults, plus a header with
 * the logo and a footer with page numbers. With a Word template, the result
 * is merged into it afterwards (`wordTemplate.js`), which keeps the
 * template's styles, headers, footers and page setup.
 *
 * @typedef {Object} DocxSpec
 * @property {string} [title]
 * @property {string} [subtitle]
 * @property {string} [author]
 * @property {string} [language] - e.g. `en`, `de`.
 * @property {string} [date]
 * @property {string} [markdown] - The body.
 * @property {boolean} [coverPage]
 * @property {boolean} [toc]
 * @property {string} [header] - Placeholders `{title}`, `{date}`, `{page}`, `{pages}`.
 * @property {string} [footer]
 * @property {boolean} [pageNumbers] - Default true.
 * @property {Object} [page] - `size`, `orientation`, `margins` ([left, top, right, bottom] in points).
 * @property {Object} [colors] - `primary`, `accent`, `text` (hex).
 * @property {Object} [fonts] - `body`, `heading` (font family names).
 * @property {number} [fontSize] - Body size in points.
 * @property {Object} [logo] - From a document template: `{ image, position, width, onCover }`.
 * @property {boolean} [markdownBreaks] - Single newlines break lines.
 * @property {boolean} [showTitle] - Print the title above the body (default true).
 */

/** Page sizes in twips (1/20 point). */
const PAGE_SIZES = Object.freeze({
  A3: [16838, 23811],
  A4: [11906, 16838],
  A5: [8391, 11906],
  LETTER: [12240, 15840],
  LEGAL: [12240, 20160]
});

const DEFAULT_MARGIN_PT = 56.7; // 2 cm

const LABELS = {
  en: { page: 'Page {page} of {pages}', contents: 'Contents' },
  de: { page: 'Seite {page} von {pages}', contents: 'Inhalt' },
  fr: { page: 'Page {page} sur {pages}', contents: 'Sommaire' },
  es: { page: 'Página {page} de {pages}', contents: 'Índice' },
  it: { page: 'Pagina {page} di {pages}', contents: 'Indice' },
  nl: { page: 'Pagina {page} van {pages}', contents: 'Inhoud' }
};

function labelsFor(language) {
  const key = typeof language === 'string' ? language.slice(0, 2).toLowerCase() : 'en';
  return LABELS[key] || LABELS.en;
}

function str(value, max = 500) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
}

function colorOr(value, fallback) {
  return isColor(value) && value.startsWith('#') ? hex(value).toUpperCase() : fallback;
}

/**
 * Page setup in twips.
 */
export function docxPageSetup(page = {}) {
  const sizeName = typeof page.size === 'string' ? page.size.toUpperCase() : 'A4';
  const size = PAGE_SIZES[sizeName] ? sizeName : 'A4';
  const landscape = page.orientation === 'landscape';
  let [width, height] = PAGE_SIZES[size];
  if (landscape) [width, height] = [height, width];
  const margins = Array.isArray(page.margins) && page.margins.length === 4 ? page.margins : [];
  const twips = (value, fallback) => Math.round((clampNumber(value, 18, 200) ?? fallback) * 20);
  const [left, top, right, bottom] = [
    twips(margins[0], DEFAULT_MARGIN_PT),
    twips(margins[1], DEFAULT_MARGIN_PT),
    twips(margins[2], DEFAULT_MARGIN_PT),
    twips(margins[3], DEFAULT_MARGIN_PT)
  ];
  return {
    width,
    height,
    landscape,
    margins: { left, top, right, bottom },
    contentWidth: width - left - right,
    contentHeight: height - top - bottom
  };
}

/**
 * Colours and fonts of a document.
 */
export function docxLook(spec) {
  const primary = colorOr(spec.colors?.primary, '1E3A8A');
  const text = colorOr(spec.colors?.text, '1F2937');
  const accent = colorOr(spec.colors?.accent, '0F766E');
  return {
    primary,
    accent,
    text,
    muted: '6B7280',
    border: 'D1D5DB',
    tableHeaderFill: primary,
    tableHeaderText: 'FFFFFF',
    tableStripeFill: 'F3F4F6',
    codeFill: 'F3F4F6',
    bodyFont: officeFontName(spec.fonts?.body, 'Calibri'),
    headingFont: officeFontName(spec.fonts?.heading || spec.fonts?.body, 'Calibri'),
    fontSize: clampNumber(spec.fontSize, 7, 16) ?? 11
  };
}

function styles(look, language) {
  const half = pt => Math.round(pt * 2);
  const size = look.fontSize;
  const heading = (scale, before, after) => ({
    run: { font: look.headingFont, size: half(size * scale), bold: true, color: look.primary },
    paragraph: { spacing: { before, after }, keepNext: true, keepLines: true }
  });
  const lang = typeof language === 'string' && language ? language : undefined;
  return {
    default: {
      document: {
        run: {
          font: look.bodyFont,
          size: half(size),
          color: look.text,
          ...(lang ? { language: { value: lang } } : {})
        },
        paragraph: { spacing: { after: 120, line: 276 } }
      },
      title: {
        run: { font: look.headingFont, size: half(size * 2.6), bold: true, color: look.primary },
        paragraph: { spacing: { before: 0, after: 80 } }
      },
      heading1: heading(1.75, 360, 120),
      heading2: heading(1.4, 280, 100),
      heading3: heading(1.2, 220, 80),
      heading4: heading(1.05, 200, 60),
      heading5: heading(1.0, 160, 40),
      heading6: heading(0.95, 160, 40),
      listParagraph: { paragraph: { spacing: { after: 60 }, contextualSpacing: true } },
      hyperlink: { run: { color: look.primary, underline: { type: 'single' } } }
    },
    paragraphStyles: [
      {
        // Looks like a top heading but stays out of the table of contents.
        id: 'TOCHeading',
        name: 'TOC Heading',
        basedOn: 'Heading1',
        next: 'Normal',
        run: { font: look.headingFont, color: look.primary },
        paragraph: { outlineLevel: 9, spacing: { before: 0, after: 200 } }
      },
      {
        id: STYLE_IDS.subtitle,
        name: 'Subtitle',
        basedOn: 'Normal',
        next: 'Normal',
        run: { size: half(size * 1.35), color: look.muted },
        paragraph: { spacing: { before: 0, after: 240 } }
      },
      {
        id: STYLE_IDS.quote,
        name: 'Quote',
        basedOn: 'Normal',
        next: 'Normal',
        run: { italics: true, color: '4B5563' },
        paragraph: {
          indent: { left: 360 },
          border: { left: { style: BorderStyle.SINGLE, size: 18, color: look.border, space: 8 } }
        }
      },
      {
        id: STYLE_IDS.caption,
        name: 'caption',
        basedOn: 'Normal',
        next: 'Normal',
        run: { italics: true, size: half(size - 1.5), color: look.muted },
        paragraph: { spacing: { before: 40, after: 160 } }
      },
      {
        id: STYLE_IDS.code,
        name: 'Code Block',
        basedOn: 'Normal',
        next: 'Normal',
        run: { font: 'Consolas', size: half(size - 1.5) },
        paragraph: {
          spacing: { before: 60, after: 160, line: 240 },
          shading: { type: ShadingType.CLEAR, color: 'auto', fill: look.codeFill },
          indent: { left: 113, right: 113 }
        }
      }
    ],
    characterStyles: [
      {
        id: STYLE_IDS.inlineCode,
        name: 'Inline Code',
        basedOn: 'DefaultParagraphFont',
        run: {
          font: 'Consolas',
          size: half(size - 1),
          shading: { type: ShadingType.CLEAR, color: 'auto', fill: look.codeFill }
        }
      }
    ]
  };
}

function numbering(look) {
  const bullets = ['•', '◦', '▪'];
  const formats = [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN];
  const levels = make =>
    Array.from({ length: 9 }, (_, level) => ({
      level,
      alignment: AlignmentType.LEFT,
      ...make(level),
      style: {
        paragraph: { indent: { left: 360 * (level + 1), hanging: 300 } },
        ...(make(level).run ? { run: make(level).run } : {})
      }
    }));
  return {
    config: [
      {
        reference: NUMBERING.bullet,
        levels: levels(level => ({
          format: LevelFormat.BULLET,
          text: bullets[level % 3],
          run: { color: look.primary }
        }))
      },
      {
        reference: NUMBERING.ordered,
        levels: levels(level => ({ format: formats[level % 3], text: `%${level + 1}.` }))
      }
    ]
  };
}

/**
 * Text with placeholders as runs: `{page}` and `{pages}` become page number
 * fields, `{title}` and `{date}` text.
 */
function placeholderRuns(text, values, runOptions = {}) {
  const runs = [];
  for (const part of String(text).split(/(\{page\}|\{pages\})/)) {
    if (part === '{page}')
      runs.push(new TextRun({ ...runOptions, children: [PageNumber.CURRENT] }));
    else if (part === '{pages}') {
      runs.push(new TextRun({ ...runOptions, children: [PageNumber.TOTAL_PAGES] }));
    } else if (part) {
      runs.push(
        new TextRun({
          ...runOptions,
          text: part.replace(/\{(title|date)\}/g, (_, key) => values[key] || '')
        })
      );
    }
  }
  return runs;
}

/** The template logo as an image run, sized to its configured width. */
function logoRun(logo, maxHeightPx) {
  if (!logo) return null;
  const check = checkImageDataUri(logo.image);
  if (!check.ok) return null;
  const pixels = imagePixelSize(check.dataUri);
  const ratio = pixels?.width > 0 && pixels?.height > 0 ? pixels.height / pixels.width : 0.4;
  // Points to pixels at 96 dpi.
  let width = (clampNumber(logo.width, 20, 300) ?? 80) * (96 / 72);
  let height = width * ratio;
  if (height > maxHeightPx) {
    width *= maxHeightPx / height;
    height = maxHeightPx;
  }
  return {
    run: scale =>
      new ImageRun({
        type: check.dataUri.startsWith('data:image/png') ? 'png' : 'jpg',
        data: Buffer.from(check.dataUri.slice(check.dataUri.indexOf(',') + 1), 'base64'),
        transformation: { width: Math.round(width * scale), height: Math.round(height * scale) },
        altText: { name: 'Logo', description: 'Logo', title: 'Logo' }
      }),
    position: logo.position
  };
}

function pageHeader(spec, look, setup, values, logo) {
  const headerText = str(spec.header, 300);
  const showLogo = logo && logo.position !== 'none';
  if (!headerText && !showLogo) return undefined;
  const textRuns = headerText
    ? placeholderRuns(headerText, values, {
        size: Math.round((look.fontSize - 2) * 2),
        color: look.muted
      })
    : [];
  const tab = new TextRun({ children: ['\t'] });
  const children =
    showLogo && logo.position === 'header-left'
      ? [logo.run(1), tab, ...textRuns]
      : [...textRuns, ...(showLogo ? [tab, logo.run(1)] : [])];
  return new Header({
    children: [
      new Paragraph({
        tabStops: [{ type: TabStopType.RIGHT, position: setup.contentWidth }],
        children
      })
    ]
  });
}

function pageFooter(spec, look, setup, values, labels) {
  const footerText = str(spec.footer, 300);
  const pageNumbers = spec.pageNumbers !== false;
  if (!footerText && !pageNumbers) return undefined;
  const options = { size: Math.round((look.fontSize - 2) * 2), color: look.muted };
  const children = footerText ? placeholderRuns(footerText, values, options) : [];
  if (pageNumbers) {
    children.push(new TextRun({ ...options, children: ['\t'] }));
    children.push(...placeholderRuns(labels.page, values, options));
  }
  return new Footer({
    children: [
      new Paragraph({
        tabStops: [{ type: TabStopType.RIGHT, position: setup.contentWidth }],
        children
      })
    ]
  });
}

function coverPage(spec, look, setup, logo) {
  const out = [];
  if (logo && spec.logo?.onCover !== false) {
    out.push(
      new Paragraph({
        alignment: logo.position === 'header-right' ? AlignmentType.RIGHT : AlignmentType.LEFT,
        children: [logo.run(1.8)]
      })
    );
  }
  out.push(
    new Paragraph({ spacing: { before: Math.round(setup.contentHeight * 0.25) }, children: [] }),
    new Paragraph({
      spacing: { after: 240 },
      indent: { right: setup.contentWidth - 1200 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 36, color: look.primary, space: 1 } },
      children: []
    }),
    new Paragraph({
      style: STYLE_IDS.title,
      spacing: { before: 120 },
      children: [new TextRun(str(spec.title) || '')]
    })
  );
  if (str(spec.subtitle)) {
    out.push(
      new Paragraph({ style: STYLE_IDS.subtitle, children: [new TextRun(str(spec.subtitle))] })
    );
  }
  const meta = [str(spec.author), str(spec.date)].filter(Boolean).join('  ·  ');
  if (meta) {
    out.push(
      new Paragraph({
        spacing: { before: 240 },
        children: [new TextRun({ text: meta, color: look.muted })]
      })
    );
  }
  out.push(new Paragraph({ children: [new PageBreak()] }));
  return out;
}

/**
 * Build the Word document.
 *
 * @param {DocxSpec} spec
 * @param {Object} [options]
 * @param {boolean} [options.forTemplate] - The result is merged into a Word
 *   template: no header, footer or logo of its own (the template has them).
 *   With `spec.titleInTemplate` (the template has a `{{title}}`
 *   placeholder) there is no title block or cover page either.
 * @param {Object} [options.setupOverride] - Page setup in twips (the
 *   template's), for sizing pictures and tables.
 * @returns {Promise<{ buffer: Buffer, warnings: string[] }>}
 */
export async function buildDocx(spec, { forTemplate = false, setupOverride } = {}) {
  if (!spec || typeof spec !== 'object') throw new Error('A document spec is required.');
  const look = docxLook(spec);
  const setup = setupOverride || docxPageSetup(spec.page || {});
  const labels = labelsFor(spec.language);
  const warnings = [];
  const ctx = {
    colors: look,
    contentWidthTwips: setup.contentWidth,
    contentWidthPx: Math.floor(setup.contentWidth / 15),
    contentHeightPx: Math.floor(setup.contentHeight / 15),
    language: typeof spec.language === 'string' ? spec.language.slice(0, 2).toLowerCase() : 'en',
    breaks: Boolean(spec.markdownBreaks),
    warnings,
    nodeCount: 0,
    imageBytes: 0
  };
  const title = str(spec.title);
  // A template with a {{title}} placeholder shows the title itself.
  const cover = Boolean(spec.coverPage) && !spec.titleInTemplate;
  const titleBlock = !cover && !spec.titleInTemplate && spec.showTitle !== false && title;
  const body = markdownToDocx(spec.markdown, ctx, {
    title: cover || titleBlock || spec.titleInTemplate ? title : undefined
  });
  if (!body.length) throw new Error('The document has no content. Provide markdown.');

  const values = {
    title: title || '',
    date: str(spec.date) || new Date().toISOString().slice(0, 10)
  };
  const logo = forTemplate ? null : logoRun(spec.logo, Math.max(24, setup.margins.top / 15 - 30));
  const children = [];
  if (cover) children.push(...coverPage(spec, look, setup, logo));
  else if (titleBlock) {
    children.push(new Paragraph({ style: STYLE_IDS.title, children: [new TextRun(title)] }));
    if (str(spec.subtitle)) {
      children.push(
        new Paragraph({ style: STYLE_IDS.subtitle, children: [new TextRun(str(spec.subtitle))] })
      );
    }
  }
  if (spec.toc) {
    children.push(
      new Paragraph({ style: 'TOCHeading', children: [new TextRun(labels.contents)] }),
      new TableOfContents(labels.contents, { hyperlink: true, headingStyleRange: '1-3' }),
      new Paragraph({ children: [new PageBreak()] })
    );
  }
  children.push(...body);

  const header = forTemplate ? undefined : pageHeader(spec, look, setup, values, logo);
  const footer = forTemplate ? undefined : pageFooter(spec, look, setup, values, labels);
  const firstPageBlank = cover && !forTemplate;
  const empty = () => new Header({ children: [new Paragraph('')] });
  const emptyFooter = () => new Footer({ children: [new Paragraph('')] });

  const doc = new Document({
    creator: str(spec.author) || 'iHub Apps',
    title: title || 'Document',
    ...(str(spec.subtitle) ? { subject: str(spec.subtitle) } : {}),
    lastModifiedBy: 'iHub Apps',
    features: { updateFields: Boolean(spec.toc) },
    styles: styles(look, spec.language),
    numbering: numbering(look),
    sections: [
      {
        properties: {
          titlePage: firstPageBlank,
          page: {
            size: {
              width: setup.width,
              height: setup.height,
              orientation: setup.landscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT
            },
            margin: { ...setup.margins, header: 567, footer: 567 }
          }
        },
        ...(header
          ? { headers: { default: header, ...(firstPageBlank ? { first: empty() } : {}) } }
          : {}),
        ...(footer
          ? { footers: { default: footer, ...(firstPageBlank ? { first: emptyFooter() } : {}) } }
          : {}),
        children
      }
    ]
  });
  const buffer = await Packer.toBuffer(doc);
  return { buffer, warnings };
}
