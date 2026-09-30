/**
 * DOCX export renderer (`docx` package).
 *
 * Follows the former browser export (`exportToDOCX` in
 * `client/src/utils/exportFormats.js`): title, app and date, one
 * "User / Assistant" heading per message, markdown converted to Word
 * paragraphs, and the settings at the end. On top of that:
 *
 * - the AI label as a shaded callout under the title (rounded "AI" badge,
 *   "AI GENERATED" caption, label text, human-review / canvas notes) and as
 *   a compact line in the page header, so it is on every page;
 * - a page footer "n / N";
 * - verification markers on assistant messages;
 * - markdown from `marked` tokens: headings, paragraphs, nested bullet and
 *   numbered lists (numbering restarts per list and honours the start
 *   number), task lists, code blocks, blockquotes, tables with a repeating
 *   header row, rules and links.
 *
 * Core properties `creator`, `title` and `description` are set; custom
 * properties are added later by `ExportSigner`.
 *
 * @module services/provenance/export/renderers/docx
 */
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeadingLevel,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  convertInchesToTwip
} from 'docx';
import { ShapeRun } from 'docx/shapes';
import { measureText } from './fontMetrics.js';
import { blockSegments, lexMarkdown, segmentsToPlainText, stripHtmlTags } from './markdown.js';
import {
  AI_BADGE_LETTERS,
  PRODUCT_NAME,
  distributeColumnWidths,
  formatDateTime,
  getDocumentMarker,
  getVerificationMarker,
  isSafeLinkTarget,
  isTranscript,
  prepareCommon,
  roleLabel,
  stripXmlInvalidChars
} from './common.js';

/** A4 (the `docx` default page) minus two 1" margins, in twips. */
const CONTENT_WIDTH_TWIPS = 11906 - 2 * 1440;

const COLORS = Object.freeze({
  muted: '718096',
  quoteText: '4A5568',
  quoteBar: 'CBD5E0',
  rule: 'CBD5E0',
  codeBg: 'F3F4F6',
  inlineCodeBg: 'EDF2F7',
  tableHeaderBg: 'EDF2F7',
  tableBorder: 'CBD5E0',
  warning: 'B7791F',
  verified: '718096',
  labelBg: 'EEF2FF',
  labelBorder: 'C7D2FE',
  labelText: '1E1B4B',
  labelDetail: '3730A3',
  badgeFill: '1E3A8A'
});

const HEADING_LEVELS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6
];

const ALIGNMENTS = Object.freeze({
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT
});

const MAX_LIST_LEVEL = 8;

/**
 * Builds the Word document body; collects the numbering definitions the
 * ordered lists need while it walks the markdown.
 */
class DocxBuilder {
  /**
   * @param {Object} params
   * @param {Function} params.t - translate function
   * @param {Object} params.doc - normalised export document
   * @param {Object} params.label - see `getLabelInfo`
   */
  constructor({ t, doc, label }) {
    this.t = t;
    this.doc = doc;
    this.label = label;
    this.numberingConfigs = [];
    this.segmentOptions = { imageLabel: t('export.content.image') };
  }

  /**
   * Word runs for inline segments.
   * @param {Array<Object>} segments - see `markdown.inlineSegments`
   * @param {{bold?: boolean, color?: string, size?: number}} [base] - run defaults
   * @returns {Array<TextRun|ExternalHyperlink>}
   */
  runs(segments, base = {}) {
    const out = [];
    for (const segment of segments) {
      if (segment.br) {
        out.push(new TextRun({ text: '', break: 1 }));
        continue;
      }
      const text = stripXmlInvalidChars(segment.text);
      if (!text) continue;
      const options = {
        text,
        ...(segment.bold || base.bold ? { bold: true } : {}),
        ...(segment.italic || base.italics ? { italics: true } : {}),
        ...(segment.strike ? { strike: true } : {}),
        ...(base.color ? { color: base.color } : {}),
        ...(base.size ? { size: base.size } : {}),
        ...(segment.code
          ? {
              font: 'Courier New',
              shading: { type: ShadingType.CLEAR, color: 'auto', fill: COLORS.inlineCodeBg }
            }
          : {})
      };
      if (segment.link && isSafeLinkTarget(segment.link)) {
        out.push(
          new ExternalHyperlink({
            link: segment.link,
            children: [new TextRun({ ...options, style: 'Hyperlink' })]
          })
        );
      } else {
        out.push(new TextRun(options));
      }
    }
    return out;
  }

  /**
   * Paragraph options that depend on where a block sits (blockquote, list item).
   * @param {{quoteDepth?: number, listIndent?: number}} ctx
   * @returns {Object}
   */
  containerProps(ctx) {
    const left =
      (ctx.quoteDepth ? ctx.quoteDepth * 360 : 0) +
      (ctx.listIndent ? convertInchesToTwip(0.5 * ctx.listIndent) : 0);
    return {
      ...(left ? { indent: { left } } : {}),
      ...(ctx.quoteDepth
        ? {
            border: {
              left: { style: BorderStyle.SINGLE, size: 12, color: COLORS.quoteBar, space: 8 }
            }
          }
        : {})
    };
  }

  /**
   * Run defaults inside a container (quotes are muted).
   * @param {Object} ctx
   * @returns {Object}
   */
  runBase(ctx) {
    return ctx.quoteDepth ? { color: COLORS.quoteText } : {};
  }

  /**
   * Word blocks for markdown tokens.
   * @param {Array<Object>} tokens - marked block tokens
   * @param {{listDepth?: number, quoteDepth?: number, listIndent?: number}} [ctx]
   * @returns {Array<Paragraph|Table>}
   */
  blocks(tokens, ctx = {}) {
    const out = [];
    for (const token of tokens || []) out.push(...this.block(token, ctx));
    return out;
  }

  /**
   * @param {Object} token - marked block token
   * @param {Object} ctx - see `blocks`
   * @returns {Array<Paragraph|Table>}
   */
  block(token, ctx) {
    const props = this.containerProps(ctx);
    const base = this.runBase(ctx);
    switch (token.type) {
      case 'space':
      case 'def':
        return [];
      case 'heading':
        return [
          new Paragraph({
            heading: HEADING_LEVELS[Math.min(Math.max(token.depth || 1, 1), 6) - 1],
            keepNext: true,
            children: this.runs(blockSegments(token, this.segmentOptions), base),
            ...props
          })
        ];
      case 'paragraph':
        return [
          new Paragraph({
            children: this.runs(blockSegments(token, this.segmentOptions), base),
            spacing: { after: 120 },
            ...props
          })
        ];
      case 'text':
        return [
          new Paragraph({
            children: this.runs(blockSegments(token, this.segmentOptions), base),
            ...props
          })
        ];
      case 'list':
        return this.list(token, ctx);
      case 'code':
        return this.code(token, props);
      case 'blockquote':
        return this.blocks(token.tokens, { ...ctx, quoteDepth: (ctx.quoteDepth || 0) + 1 });
      case 'table':
        return this.table(token);
      case 'hr':
        return [
          new Paragraph({
            children: [],
            border: {
              bottom: { style: BorderStyle.SINGLE, size: 6, color: COLORS.rule, space: 1 }
            },
            spacing: { after: 120 }
          })
        ];
      case 'html': {
        const text = stripHtmlTags(token.text);
        if (!text) return [];
        return [
          new Paragraph({
            children: this.runs([{ text }], { ...base, color: COLORS.muted }),
            spacing: { after: 120 },
            ...props
          })
        ];
      }
      default:
        if (Array.isArray(token.tokens) && token.type !== 'text')
          return this.blocks(token.tokens, ctx);
        if (typeof token.text === 'string' && token.text.trim()) {
          return [
            new Paragraph({
              children: this.runs(blockSegments(token, this.segmentOptions), base),
              ...props
            })
          ];
        }
        return [];
    }
  }

  /**
   * Code block: one shaded monospace paragraph per line.
   * @param {Object} token - marked code token
   * @param {Object} props - container paragraph options
   * @returns {Paragraph[]}
   */
  code(token, props) {
    const lines = String(token.text || '')
      .replace(/\t/g, '    ')
      .split('\n');
    return lines.map(
      (line, index) =>
        new Paragraph({
          children: [
            new TextRun({ text: stripXmlInvalidChars(line) || ' ', font: 'Courier New', size: 18 })
          ],
          shading: { type: ShadingType.CLEAR, color: 'auto', fill: COLORS.codeBg },
          spacing: { before: 0, after: index === lines.length - 1 ? 160 : 0 },
          ...props
        })
    );
  }

  /**
   * Bulleted / numbered / task list. Each ordered list gets its own numbering
   * definition so numbering restarts and honours the list's start number.
   * @param {Object} token - marked list token
   * @param {Object} ctx
   * @returns {Array<Paragraph|Table>}
   */
  list(token, ctx) {
    const depth = Math.min(ctx.listDepth || 0, MAX_LIST_LEVEL);
    let numbering = null;
    if (token.ordered) {
      const start =
        token.start !== '' && Number.isInteger(Number(token.start)) ? Number(token.start) : 1;
      const reference = `ihub-ordered-${this.numberingConfigs.length + 1}`;
      this.numberingConfigs.push(orderedNumberingConfig(reference, start));
      numbering = { reference, level: depth };
    }
    const itemProps = numbering ? { numbering } : { bullet: { level: depth } };
    const quoteProps = this.containerProps({ quoteDepth: ctx.quoteDepth });
    const base = this.runBase(ctx);
    const out = [];
    for (const item of token.items || []) {
      const children = (item.tokens || []).filter(child => child.type !== 'checkbox');
      const prefix = item.task ? [new TextRun({ text: item.checked ? '☑ ' : '☐ ' })] : [];
      const [first, ...rest] = children;
      const firstIsText = first && (first.type === 'text' || first.type === 'paragraph');
      out.push(
        new Paragraph({
          children: [
            ...prefix,
            ...(firstIsText ? this.runs(blockSegments(first, this.segmentOptions), base) : [])
          ],
          ...itemProps,
          ...(quoteProps.border ? { border: quoteProps.border } : {})
        })
      );
      for (const child of firstIsText ? rest : children) {
        if (child.type === 'list') {
          out.push(...this.list(child, { ...ctx, listDepth: depth + 1 }));
        } else {
          out.push(...this.block(child, { ...ctx, listIndent: depth + 1 }));
        }
      }
    }
    out.push(new Paragraph({ children: [], spacing: { after: 60 } }));
    return depth === 0 ? out : out.slice(0, -1);
  }

  /**
   * Markdown table as a Word table; the header row repeats on page breaks.
   * @param {Object} token - marked table token
   * @returns {Array<Table|Paragraph>}
   */
  table(token) {
    const header = token.header || [];
    const columnCount = header.length;
    if (!columnCount) return [];
    const headerSegments = header.map(cell => blockSegments(cell, this.segmentOptions));
    const bodySegments = (token.rows || []).map(row =>
      Array.from({ length: columnCount }, (_, c) =>
        row[c] ? blockSegments(row[c], this.segmentOptions) : []
      )
    );
    const natural = Array(columnCount).fill(0);
    [headerSegments, ...bodySegments].forEach(row =>
      row.forEach((segments, c) => {
        const widest = Math.max(
          0,
          ...segmentsToPlainText(segments)
            .split('\n')
            .map(line => measureText(line, 10))
        );
        // points → twips, plus cell margins
        natural[c] = Math.max(natural[c], widest * 20 + 240, 600);
      })
    );
    const widths = distributeColumnWidths(natural, CONTENT_WIDTH_TWIPS).map(Math.round);
    const cell = (segments, c, isHeader) =>
      new TableCell({
        width: { size: widths[c], type: WidthType.DXA },
        margins: { top: 60, bottom: 60, left: 100, right: 100 },
        ...(isHeader
          ? { shading: { type: ShadingType.CLEAR, color: 'auto', fill: COLORS.tableHeaderBg } }
          : {}),
        children: [
          new Paragraph({
            alignment: ALIGNMENTS[token.align?.[c]] || AlignmentType.LEFT,
            children: this.runs(segments, isHeader ? { bold: true } : {})
          })
        ]
      });
    const border = { style: BorderStyle.SINGLE, size: 4, color: COLORS.tableBorder };
    return [
      new Table({
        width: { size: CONTENT_WIDTH_TWIPS, type: WidthType.DXA },
        columnWidths: widths,
        borders: {
          top: border,
          bottom: border,
          left: border,
          right: border,
          insideHorizontal: border,
          insideVertical: border
        },
        rows: [
          new TableRow({
            tableHeader: true,
            children: headerSegments.map((segments, c) => cell(segments, c, true))
          }),
          ...bodySegments.map(
            row => new TableRow({ children: row.map((segments, c) => cell(segments, c, false)) })
          )
        ]
      }),
      new Paragraph({ children: [], spacing: { after: 120 } })
    ];
  }

  /**
   * The rounded "AI" badge as a DrawingML shape.
   * @param {number} width - pixels
   * @param {number} height - pixels
   * @param {number} size - letter size in half-points
   * @returns {ShapeRun}
   */
  badge(width, height, size) {
    return new ShapeRun({
      type: 'roundedRectangle',
      adjustments: { cornerRadius: 26 },
      transformation: { width, height },
      fill: COLORS.badgeFill,
      line: 'none',
      altText: {
        name: AI_BADGE_LETTERS,
        title: this.label.badgeCaption,
        description: this.t('export.label.badgeAlt')
      },
      textOptions: {
        verticalAlignment: 'center',
        wrap: false,
        margins: { top: 0, bottom: 0, left: 0, right: 0 }
      },
      children: [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 0, after: 0 },
          children: [
            new TextRun({
              text: AI_BADGE_LETTERS,
              bold: true,
              color: 'FFFFFF',
              size,
              font: 'Arial'
            })
          ]
        })
      ]
    });
  }

  /**
   * The AI label callout under the title.
   * @returns {Paragraph[]}
   */
  labelCallout() {
    const { label } = this;
    if (!label.show) return [];
    const border = { style: BorderStyle.SINGLE, size: 6, color: COLORS.labelBorder, space: 6 };
    const box = {
      shading: { type: ShadingType.CLEAR, color: 'auto', fill: COLORS.labelBg },
      border: { top: border, bottom: border, left: border, right: border },
      spacing: { before: 0, after: 0 }
    };
    const out = [];
    if (label.euIcon) {
      out.push(
        new Paragraph({
          ...box,
          spacing: { before: 0, after: 60 },
          children: [
            this.badge(38, 24, 20),
            new TextRun({
              text: `  ${stripXmlInvalidChars(label.badgeCaption)}`,
              bold: true,
              size: 16,
              color: COLORS.badgeFill
            })
          ]
        })
      );
    }
    out.push(
      new Paragraph({
        ...box,
        children: [
          new TextRun({
            text: stripXmlInvalidChars(label.text),
            bold: true,
            color: COLORS.labelText
          })
        ]
      })
    );
    for (const detail of label.details) {
      out.push(
        new Paragraph({
          ...box,
          children: [
            new TextRun({ text: stripXmlInvalidChars(detail), size: 18, color: COLORS.labelDetail })
          ]
        })
      );
    }
    out.push(new Paragraph({ children: [], spacing: { after: 120 } }));
    return out;
  }

  /**
   * Page header with the compact label (every page).
   * @returns {Header|null}
   */
  pageHeader() {
    const { label } = this;
    if (!label.show) return null;
    return new Header({
      children: [
        new Paragraph({
          border: {
            bottom: { style: BorderStyle.SINGLE, size: 4, color: 'E2E8F0', space: 4 }
          },
          children: [
            ...(label.euIcon
              ? [this.badge(26, 16, 14), new TextRun({ text: '  ', size: 16 })]
              : []),
            new TextRun({ text: stripXmlInvalidChars(label.text), size: 16, color: '4A5568' })
          ]
        })
      ]
    });
  }

  /**
   * Page footer "n / N" (every page).
   * @returns {Footer}
   */
  pageFooter() {
    // The template has {current} and {total} placeholders; they become Word fields.
    const parts = this.t('export.footer.page')
      .split(/(\{current\}|\{total\})/)
      .filter(Boolean)
      .map(part => {
        if (part === '{current}') return PageNumber.CURRENT;
        if (part === '{total}') return PageNumber.TOTAL_PAGES;
        return part;
      });
    return new Footer({
      children: [
        new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [new TextRun({ children: parts, size: 16, color: COLORS.muted })]
        })
      ]
    });
  }

  /**
   * Meta line (timestamp, model) and verification marker of a message.
   * @param {Object} message
   * @param {Object|null} marker
   * @returns {Paragraph[]}
   */
  messageMeta(message, marker) {
    const out = [];
    const meta = [formatDateTime(message.timestamp, this.doc.language), message.model]
      .filter(Boolean)
      .join(' · ');
    if (meta) {
      out.push(
        new Paragraph({
          children: [
            new TextRun({
              text: stripXmlInvalidChars(meta),
              italics: true,
              size: 18,
              color: COLORS.muted
            })
          ]
        })
      );
    }
    if (marker) {
      out.push(
        new Paragraph({
          spacing: { after: 80 },
          children: [
            new TextRun({
              text: marker.text,
              italics: true,
              size: 16,
              color: marker.kind === 'warning' ? COLORS.warning : COLORS.verified
            })
          ]
        })
      );
    }
    return out;
  }

  /**
   * The whole body.
   * @param {{exportedOn: string, settingsRows: Array<[string, string]>}} common
   * @returns {Array<Paragraph|Table>}
   */
  body({ exportedOn, settingsRows }) {
    const { t, doc } = this;
    const children = [
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: stripXmlInvalidChars(doc.title) })]
      }),
      new Paragraph({
        children: [
          new TextRun({ text: `${t('export.header.app')}: `, bold: true }),
          new TextRun({ text: stripXmlInvalidChars(doc.appName) })
        ]
      }),
      new Paragraph({
        spacing: { after: 160 },
        children: [new TextRun({ text: exportedOn, color: COLORS.muted })]
      }),
      ...this.labelCallout()
    ];

    if (isTranscript(doc)) {
      for (const message of doc.messages) {
        children.push(
          new Paragraph({
            heading: HeadingLevel.HEADING_2,
            keepNext: true,
            children: [new TextRun({ text: roleLabel(message.role, t) })]
          }),
          ...this.messageMeta(message, getVerificationMarker(message, t)),
          ...this.blocks(lexMarkdown(message.content)),
          new Paragraph({ children: [] })
        );
      }
    } else {
      for (const message of doc.messages) {
        children.push(
          ...this.messageMeta(message, getDocumentMarker(doc, message, t)),
          ...this.blocks(lexMarkdown(message.content))
        );
      }
    }

    if (settingsRows.length > 0) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          children: [new TextRun({ text: t('export.settings.title') })]
        }),
        ...settingsRows.map(
          ([name, value]) =>
            new Paragraph({
              children: [
                new TextRun({ text: `${name}: `, bold: true }),
                new TextRun({ text: stripXmlInvalidChars(value) })
              ]
            })
        )
      );
    }
    return children;
  }
}

/**
 * Numbering definition for one ordered list.
 * @param {string} reference - unique numbering reference
 * @param {number} start - first number
 * @returns {Object} a `docx` numbering config
 */
function orderedNumberingConfig(reference, start) {
  return {
    reference,
    levels: Array.from({ length: MAX_LIST_LEVEL + 1 }, (_, level) => ({
      level,
      format: LevelFormat.DECIMAL,
      text: `%${level + 1}.`,
      start,
      alignment: AlignmentType.LEFT,
      style: {
        paragraph: {
          indent: {
            left: convertInchesToTwip(0.5 * (level + 1)),
            hanging: convertInchesToTwip(0.25)
          }
        }
      }
    }))
  };
}

/**
 * Render the export as DOCX.
 *
 * @param {Object} doc - normalised export document (see `renderExport`)
 * @returns {Promise<Buffer>} the DOCX bytes
 */
export async function renderDocx(doc) {
  const common = prepareCommon(doc);
  const builder = new DocxBuilder({ t: common.t, doc, label: common.label });
  const children = builder.body(common);
  const header = builder.pageHeader();
  const document = new Document({
    creator: stripXmlInvalidChars(doc.appName),
    lastModifiedBy: PRODUCT_NAME,
    title: stripXmlInvalidChars(doc.title),
    description: stripXmlInvalidChars(common.label.show ? common.label.text : doc.appName),
    numbering: { config: builder.numberingConfigs },
    sections: [
      {
        ...(header ? { headers: { default: header } } : {}),
        footers: { default: builder.pageFooter() },
        children
      }
    ]
  });
  return Packer.toBuffer(document);
}
