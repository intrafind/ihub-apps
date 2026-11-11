// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { Lexer } from 'marked';
import { xmlEscape } from '../ooxml/opcPackage.js';
import { decodeEntities, stripTags } from '../pdf/markdownToPdfmake.js';
import { safeLink } from '../pdf/validators.js';

/**
 * PresentationML/DrawingML writers for generated slides: text bodies from
 * Markdown, placeholders, pictures and tables.
 *
 * Text is written without fonts, sizes or colours wherever the template has
 * them: a paragraph in a body placeholder inherits the bullets, sizes and
 * colours of the template's master, so the slides look like the company's
 * own. Only emphasis (bold, italic, code, links) is set on runs.
 */

export const EMU_PER_INCH = 914400;
export const EMU_PER_POINT = 12700;

export const PML_NAMESPACES =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

export const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

export const GROUP_PROPS =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

/** Most characters of text one slide holds. */
export const MAX_SLIDE_TEXT = 8000;

/**
 * @typedef {Object} Run
 * @property {string} text
 * @property {boolean} [bold]
 * @property {boolean} [italic]
 * @property {boolean} [strike]
 * @property {boolean} [underline]
 * @property {boolean} [code]
 * @property {'sup'|'sub'} [baseline]
 * @property {string} [link]
 *
 * @typedef {Object} TextParagraph
 * @property {Run[]} runs
 * @property {number} [level] - 0-based list level.
 * @property {'bullet'|'number'|null} [list]
 * @property {boolean} [heading] - A heading inside the text: bold, no bullet.
 */

const INLINE_HTML = {
  sub: { baseline: 'sub' },
  sup: { baseline: 'sup' },
  u: { underline: true },
  ins: { underline: true },
  s: { strike: true },
  del: { strike: true },
  b: { bold: true },
  strong: { bold: true },
  i: { italic: true },
  em: { italic: true },
  code: { code: true }
};

/**
 * Inline Markdown tokens → runs.
 *
 * @param {Array} tokens
 * @param {Object} [style]
 * @returns {Run[]}
 */
export function inlineRuns(tokens, style = {}) {
  const runs = [];
  const stack = [];
  const effective = () => stack.reduce((acc, s) => ({ ...acc, ...s }), style);
  const push = (text, extra = {}) => {
    if (text === '' || text === undefined || text === null) return;
    runs.push({ text: String(text), ...effective(), ...extra });
  };
  for (const token of tokens || []) {
    switch (token.type) {
      case 'text':
      case 'escape':
        if (token.tokens?.length) runs.push(...inlineRuns(token.tokens, effective()));
        else push(decodeEntities(token.text));
        break;
      case 'strong':
        runs.push(...inlineRuns(token.tokens, { ...effective(), bold: true }));
        break;
      case 'em':
        runs.push(...inlineRuns(token.tokens, { ...effective(), italic: true }));
        break;
      case 'del':
        runs.push(...inlineRuns(token.tokens, { ...effective(), strike: true }));
        break;
      case 'codespan':
        push(decodeEntities(token.text), { code: true });
        break;
      case 'br':
        push('\v');
        break;
      case 'link': {
        const href = safeLink(token.href);
        runs.push(...inlineRuns(token.tokens, href ? { ...effective(), link: href } : effective()));
        break;
      }
      case 'image':
        push(token.text ? `[${token.text}]` : '', { italic: true });
        break;
      case 'html': {
        const raw = String(token.raw || token.text || '').trim();
        const open = /^<([a-z]+)\b[^>]*>$/i.exec(raw);
        const close = /^<\/([a-z]+)\s*>$/i.exec(raw);
        if (/^<br\s*\/?>$/i.test(raw)) push('\v');
        else if (open && INLINE_HTML[open[1].toLowerCase()]) {
          stack.push(INLINE_HTML[open[1].toLowerCase()]);
        } else if (close && INLINE_HTML[close[1].toLowerCase()]) stack.pop();
        else if (!raw.startsWith('<!--')) push(stripTags(raw));
        break;
      }
      default:
        if (token.tokens?.length) runs.push(...inlineRuns(token.tokens, effective()));
        else if (typeof token.text === 'string') push(decodeEntities(token.text));
    }
  }
  return runs;
}

/**
 * Markdown for a slide → paragraphs, plus the first GFM table, which a slide
 * shows as a real table.
 *
 * @param {string} markdown
 * @returns {{ paragraphs: TextParagraph[], table: { header: string[], rows: string[][], align: string[] } | null }}
 */
export function markdownToSlideText(markdown) {
  const text = String(markdown ?? '').slice(0, MAX_SLIDE_TEXT);
  const tokens = new Lexer({ gfm: true }).lex(text);
  const paragraphs = [];
  let table = null;
  const walk = (list, level) => {
    for (const token of list) {
      switch (token.type) {
        case 'space':
        case 'hr':
        case 'def':
          break;
        case 'heading':
          paragraphs.push({ runs: inlineRuns(token.tokens, { bold: true }), heading: true });
          break;
        case 'paragraph':
        case 'text':
          paragraphs.push({
            runs: token.tokens ? inlineRuns(token.tokens) : [{ text: token.text }],
            level
          });
          break;
        case 'list':
          for (const item of token.items) {
            let first = true;
            for (const child of item.tokens || []) {
              if (child.type === 'list') {
                walk([child], level + 1);
                continue;
              }
              if (child.type !== 'text' && child.type !== 'paragraph') {
                walk([child], level + 1);
                continue;
              }
              const runs = child.tokens ? inlineRuns(child.tokens) : [{ text: child.text }];
              if (item.task && first) runs.unshift({ text: item.checked ? '☑ ' : '☐ ' });
              paragraphs.push({
                runs,
                level: Math.min(level, 8),
                list: first ? (token.ordered ? 'number' : 'bullet') : null
              });
              first = false;
            }
          }
          break;
        case 'blockquote':
          for (const child of token.tokens || []) {
            if (child.tokens) {
              paragraphs.push({ runs: inlineRuns(child.tokens, { italic: true }), level });
            }
          }
          break;
        case 'code':
          for (const line of String(token.text || '').split('\n')) {
            paragraphs.push({ runs: [{ text: line || ' ', code: true }], level });
          }
          break;
        case 'table':
          if (!table) {
            table = {
              header: token.header.map(cell => cell.text),
              rows: token.rows.map(row => row.map(cell => cell.text)),
              align: token.align || []
            };
          }
          break;
        default:
          if (token.tokens?.length) paragraphs.push({ runs: inlineRuns(token.tokens), level });
          else if (typeof token.text === 'string' && token.text.trim()) {
            paragraphs.push({ runs: [{ text: decodeEntities(token.text) }], level });
          }
      }
    }
  };
  walk(tokens, 0);
  return { paragraphs: paragraphs.filter(p => p.runs.some(r => r.text.trim())), table };
}

/**
 * The plain text length of paragraphs, for fitting.
 */
export function textLength(paragraphs) {
  return paragraphs.reduce((sum, p) => sum + p.runs.reduce((n, r) => n + r.text.length, 0), 0);
}

/**
 * A run's XML. Links need a relationship id from the caller.
 *
 * @param {Run} run
 * @param {Object} options
 * @param {string} options.lang
 * @param {(url: string) => string} [options.linkId]
 * @param {Object} [options.rPr] - Extra attributes (`sz`, …) and `fill` (XML).
 */
export function runXml(run, { lang, linkId, rPr = {} }) {
  const attrs = [`lang="${xmlEscape(lang)}"`];
  if (rPr.sz) attrs.push(`sz="${rPr.sz}"`);
  if (run.bold || rPr.bold) attrs.push('b="1"');
  if (run.italic) attrs.push('i="1"');
  if (run.underline) attrs.push('u="sng"');
  if (run.strike) attrs.push('strike="sngStrike"');
  if (run.baseline === 'sup') attrs.push('baseline="30000"');
  if (run.baseline === 'sub') attrs.push('baseline="-25000"');
  attrs.push('dirty="0"');
  let children = rPr.fill || '';
  if (run.code) children += '<a:latin typeface="Consolas"/><a:cs typeface="Consolas"/>';
  if (run.link && linkId) children += `<a:hlinkClick r:id="${linkId(run.link)}"/>`;
  const parts = run.text.split('\v');
  return parts
    .map((part, index) => {
      const br = index > 0 ? `<a:br><a:rPr ${attrs.join(' ')}/></a:br>` : '';
      return `${br}<a:r><a:rPr ${attrs.join(' ')}>${children}</a:rPr><a:t>${xmlEscape(part)}</a:t></a:r>`;
    })
    .join('');
}

/**
 * Paragraphs for a placeholder or text box.
 *
 * - `bullets: true` (body placeholders): list items keep the template's
 *   bullets (or get automatic numbers); plain paragraphs have none.
 * - `bullets: 'explicit'` (text boxes, which have no list styles): list
 *   items get bullets and indents of their own, sized from `sizes`.
 * - `bullets: false` (titles, table cells): no bullets at all.
 *
 * @param {TextParagraph[]} paragraphs
 * @param {Object} options - `lang`, `linkId`, `bullets`, `align`, `rPr`,
 *   `sizes` (hundredths of a point per level, for explicit bullets).
 * @returns {string}
 */
export function paragraphsXml(
  paragraphs,
  { lang, linkId, bullets = true, align, rPr = {}, sizes = [] }
) {
  if (!paragraphs.length) return `<a:p><a:endParaRPr lang="${xmlEscape(lang)}" dirty="0"/></a:p>`;
  const explicit = bullets === 'explicit';
  return paragraphs
    .map(paragraph => {
      const level = Math.max(0, Math.min(8, paragraph.level || 0));
      const attrs = [];
      if (level > 0 && !explicit) attrs.push(`lvl="${level}"`);
      if (align) attrs.push(`algn="${align}"`);
      const isItem = !paragraph.heading && Boolean(paragraph.list);
      let bullet = '';
      if (explicit) {
        const marL = isItem || paragraph.list === null ? 285750 * (level + 1) : 0;
        attrs.push(`marL="${marL}"`, `indent="${isItem ? -285750 : 0}"`);
        if (paragraph.list === 'bullet' && isItem) {
          bullet = `<a:buFont typeface="Arial"/><a:buChar char="${level % 2 ? '–' : '•'}"/>`;
        } else if (paragraph.list === 'number' && isItem) {
          bullet = '<a:buFont typeface="+mj-lt"/><a:buAutoNum type="arabicPeriod"/>';
        } else bullet = '<a:buNone/>';
      } else if (!bullets || !isItem) {
        bullet = '<a:buNone/>';
        // A plain paragraph starts at the margin; a further paragraph of a
        // list item lines up with the item's text.
        if (bullets && paragraph.list === null && level > 0) attrs.push('indent="0"');
        else if (bullets) attrs.push('marL="0"', 'indent="0"');
      } else if (paragraph.list === 'number') {
        bullet = '<a:buFont typeface="+mj-lt"/><a:buAutoNum type="arabicPeriod"/>';
      }
      const size = rPr.sz || (explicit ? sizes[Math.min(level, sizes.length - 1)] : undefined);
      const runs = paragraph.runs
        .map(run =>
          runXml(run, {
            lang,
            linkId,
            rPr: { ...rPr, ...(size ? { sz: size } : {}), bold: rPr.bold || paragraph.heading }
          })
        )
        .join('');
      return `<a:p><a:pPr${attrs.length ? ` ${attrs.join(' ')}` : ''}>${bullet}</a:pPr>${runs}<a:endParaRPr lang="${xmlEscape(lang)}" dirty="0"/></a:p>`;
    })
    .join('');
}

/**
 * A placeholder shape on a slide: it points at the layout's placeholder of
 * the same type and index, and inherits its position unless `rect` is given.
 *
 * @param {Object} params
 * @param {number} params.id - Shape id, unique on the slide.
 * @param {string} params.name
 * @param {{ type?: string, idx?: string }} params.ph - The layout placeholder.
 * @param {string} params.body - Paragraph XML.
 * @param {Object} [params.rect] - `{ x, y, cx, cy }` in EMU.
 * @param {string} [params.bodyPr] - `a:bodyPr` children (autofit).
 */
export function placeholderShape({ id, name, ph, body, rect, bodyPr = '' }) {
  const phAttrs = [];
  if (ph.type && ph.type !== 'obj') phAttrs.push(`type="${xmlEscape(ph.type)}"`);
  if (ph.idx) phAttrs.push(`idx="${xmlEscape(ph.idx)}"`);
  if (ph.orient) phAttrs.push(`orient="${xmlEscape(ph.orient)}"`);
  const spPr = rect
    ? `<p:spPr><a:xfrm><a:off x="${rect.x}" y="${rect.y}"/><a:ext cx="${rect.cx}" cy="${rect.cy}"/></a:xfrm></p:spPr>`
    : '<p:spPr/>';
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xmlEscape(name)}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph${phAttrs.length ? ` ${phAttrs.join(' ')}` : ''}/></p:nvPr></p:nvSpPr>${spPr}<p:txBody><a:bodyPr>${bodyPr}</a:bodyPr><a:lstStyle/>${body}</p:txBody></p:sp>`;
}

/**
 * A free text box (used where the layout has no placeholder for the text).
 */
export function textBoxShape({ id, name, rect, body, bodyPr = '', anchor = 't' }) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xmlEscape(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${rect.x}" y="${rect.y}"/><a:ext cx="${rect.cx}" cy="${rect.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="${anchor}">${bodyPr}</a:bodyPr><a:lstStyle/>${body}</p:txBody></p:sp>`;
}

/**
 * A picture, fitted into a rectangle and centred.
 */
export function pictureShape({ id, name, rect, relId, description = '' }) {
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${xmlEscape(name)}" descr="${xmlEscape(description)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${rect.x}" y="${rect.y}"/><a:ext cx="${rect.cx}" cy="${rect.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
}

/** Relative luminance of a hex colour (0 dark … 1 light). */
export function luminance(hex) {
  const value = String(hex || '').replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(value)) return 0.3;
  const channel = i => {
    const c = Number.parseInt(value.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/** Column alignments; a `Map`, as the value comes from the model. */
const TABLE_ALIGN = new Map([
  ['right', 'r'],
  ['center', 'ctr']
]);

/**
 * A table in the template's accent colour: header row filled with accent 1,
 * banded rows in a light tint of it, white rules — "Medium Style 2", written
 * out cell by cell so every viewer draws it the same.
 *
 * @param {Object} params
 * @param {number} params.id
 * @param {Object} params.rect
 * @param {{ header: string[], rows: string[][], align?: string[] }} params.table
 * @param {string} params.lang
 * @param {string} params.accent - Accent 1 as hex (for contrast).
 * @param {number} params.fontSize - Points.
 * @param {number[]} params.columnWidths - EMU.
 * @param {number} params.rowHeight - EMU.
 */
export function tableFrame({ id, rect, table, lang, accent, fontSize, columnWidths, rowHeight }) {
  const headerText = luminance(accent) > 0.55 ? 'tx1' : 'bg1';
  const sz = Math.round(fontSize * 100);
  const line = side =>
    `<a:${side} w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:prstDash val="solid"/></a:${side}>`;
  const borders = ['lnL', 'lnR', 'lnT', 'lnB'].map(line).join('');
  const cell = (text, column, header, band) => {
    const align = TABLE_ALIGN.get(table.align?.[column]) || 'l';
    const fill = header
      ? '<a:solidFill><a:schemeClr val="accent1"/></a:solidFill>'
      : band
        ? '<a:solidFill><a:schemeClr val="accent1"><a:lumMod val="20000"/><a:lumOff val="80000"/></a:schemeClr></a:solidFill>'
        : '<a:solidFill><a:schemeClr val="accent1"><a:lumMod val="10000"/><a:lumOff val="90000"/></a:schemeClr></a:solidFill>';
    const runFill = header ? `<a:solidFill><a:schemeClr val="${headerText}"/></a:solidFill>` : '';
    const runs = inlineRuns(new Lexer({ gfm: true }).inlineTokens(String(text ?? '')));
    const body = paragraphsXml([{ runs: runs.length ? runs : [{ text: '' }] }], {
      lang,
      bullets: false,
      align,
      rPr: { sz, bold: header, fill: runFill }
    });
    return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${body}</a:txBody><a:tcPr marL="91440" marR="91440" marT="45720" marB="45720" anchor="ctr">${borders}${fill}</a:tcPr></a:tc>`;
  };
  const rows = [
    `<a:tr h="${rowHeight}">${table.header.map((text, c) => cell(text, c, true, false)).join('')}</a:tr>`,
    ...table.rows.map(
      (row, r) =>
        `<a:tr h="${rowHeight}">${table.header.map((_, c) => cell(row[c], c, false, r % 2 === 1)).join('')}</a:tr>`
    )
  ];
  const width = columnWidths.reduce((a, b) => a + b, 0);
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${rect.x}" y="${rect.y}"/><a:ext cx="${width}" cy="${rowHeight * rows.length}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}</a:tableStyleId></a:tblPr><a:tblGrid>${columnWidths.map(w => `<a:gridCol w="${w}"/>`).join('')}</a:tblGrid>${rows.join('')}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

/** Fill and text a metric card falls back to when the template's own colours do not suit it. */
const METRIC_FALLBACK_FILL = 'F2F2F2';
const METRIC_FALLBACK_TEXT = '262626';
/** Accents less saturated than this are greys: they do not make a good highlight colour. */
const NEUTRAL_SATURATION = 0.25;
const ACCENT_ROLES = ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'];

function cleanHex(value) {
  const hex = String(value || '').replace('#', '');
  return /^[0-9a-f]{6}$/i.test(hex) ? hex.toUpperCase() : null;
}

/** HSL saturation of a hex colour (0 grey … 1 fully saturated). */
function saturation(hex) {
  const [r, g, b] = [0, 2, 4].map(i => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  return d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
}

/** WCAG contrast ratio of two hex colours. */
function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/**
 * How a metric card looks in a template: a light neutral card (the theme's
 * `lt2`) with the theme's dark text colour (`dk2`) and a rule in the first
 * accent that is a real colour, so a template whose `accent1` is grey still
 * gets a colourful highlight. The card never follows the template's `tx1` or
 * `bg1`, which a template can map to white or black.
 *
 * @param {Object<string, string>} [colors] - The theme's colours by role (`dk2`, `lt2`, `accent1` …).
 * @returns {{ fill: string, text: string, accent: string, valueFill: string }}
 */
export function metricCardStyle(colors = {}) {
  const lt2 = cleanHex(colors.lt2);
  const fill = lt2 && luminance(lt2) > 0.8 ? lt2 : METRIC_FALLBACK_FILL;
  const dk2 = cleanHex(colors.dk2);
  const text = dk2 && contrast(dk2, fill) >= 4.5 ? dk2 : METRIC_FALLBACK_TEXT;
  const role =
    ACCENT_ROLES.find(
      name => cleanHex(colors[name]) && saturation(cleanHex(colors[name])) >= NEUTRAL_SATURATION
    ) || 'accent1';
  const accentHex = cleanHex(colors[role]);
  const readable = accentHex && contrast(accentHex, fill) >= 4.5;
  return {
    fill,
    text,
    accent: role,
    valueFill: readable ? `<a:schemeClr val="${role}"/>` : `<a:srgbClr val="${text}"/>`
  };
}

/**
 * Row of 1–4 KPI / big-number callout cards. Each card is a group of a light
 * neutral card and a rule across its top in the template's highlight colour
 * (see {@link metricCardStyle}); the value takes that colour too when it is
 * readable on the card (4.5:1), else the text colour.
 *
 * @param {Object} params
 * @param {() => number} params.nextId
 * @param {{ x: number, y: number, cx: number, cy: number }} params.rect
 * @param {Array<{ value: string, label: string, note?: string }>} params.metrics
 * @param {string} params.lang
 * @param {Object<string, string>} [params.colors] - The template's theme colours by role.
 * @returns {string[]} One group shape per metric.
 */
export function metricCards({ nextId, rect, metrics, lang, colors }) {
  const count = metrics.length;
  if (!count) return [];
  const gap = Math.round((rect.cx < 5 * EMU_PER_INCH ? 0.16 : 0.22) * EMU_PER_INCH);
  const cardWidth = Math.max(1, Math.floor((rect.cx - gap * (count - 1)) / count));
  const cardHeight = Math.min(rect.cy, Math.round(2.2 * EMU_PER_INCH));
  const cardY = Math.round(rect.y + Math.max(0, (rect.cy - cardHeight) / 2));
  const ruleHeight = Math.min(cardHeight, 38100);
  const compact = cardHeight < Math.round(1.4 * EMU_PER_INCH);
  const valSz = compact
    ? 2200
    : count <= 2 && rect.cx > 6 * EMU_PER_INCH
      ? 3600
      : count === 3
        ? 3000
        : 2400;
  const labelSz = compact ? 1200 : 1400;
  const noteSz = 1100;
  const safeLang = xmlEscape(lang);
  const style = metricCardStyle(colors);
  const textFill = `<a:solidFill><a:srgbClr val="${style.text}"/></a:solidFill>`;

  return metrics.map((metric, idx) => {
    const groupId = nextId();
    const cardId = nextId();
    const ruleId = nextId();
    const x = rect.x + idx * (cardWidth + gap);
    const valPara = `<a:p><a:pPr algn="l"><a:spcAft><a:spcPts val="300"/></a:spcAft><a:buNone/></a:pPr><a:r><a:rPr lang="${safeLang}" sz="${valSz}" b="1" dirty="0"><a:solidFill>${style.valueFill}</a:solidFill></a:rPr><a:t>${xmlEscape(metric.value)}</a:t></a:r><a:endParaRPr lang="${safeLang}" dirty="0"/></a:p>`;
    const labelPara = `<a:p><a:pPr algn="l"><a:buNone/></a:pPr><a:r><a:rPr lang="${safeLang}" sz="${labelSz}" b="1" dirty="0">${textFill}</a:rPr><a:t>${xmlEscape(metric.label)}</a:t></a:r><a:endParaRPr lang="${safeLang}" dirty="0"/></a:p>`;
    const notePara = metric.note
      ? `<a:p><a:pPr algn="l"><a:spcBef><a:spcPts val="200"/></a:spcBef><a:buNone/></a:pPr><a:r><a:rPr lang="${safeLang}" sz="${noteSz}" dirty="0">${textFill}</a:rPr><a:t>${xmlEscape(metric.note)}</a:t></a:r><a:endParaRPr lang="${safeLang}" dirty="0"/></a:p>`
      : '';
    const frame = `<a:off x="${x}" y="${cardY}"/><a:ext cx="${cardWidth}" cy="${cardHeight}"/>`;
    const card = `<p:sp><p:nvSpPr><p:cNvPr id="${cardId}" name="Metric ${cardId}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm>${frame}</a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${style.fill}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="137160" tIns="137160" rIns="137160" bIns="91440" rtlCol="0" anchor="t"><a:normAutofit/></a:bodyPr><a:lstStyle/>${valPara}${labelPara}${notePara}</p:txBody></p:sp>`;
    const rule = `<p:sp><p:nvSpPr><p:cNvPr id="${ruleId}" name="Metric rule ${ruleId}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${cardY}"/><a:ext cx="${cardWidth}" cy="${ruleHeight}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="${style.accent}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr rtlCol="0" anchor="ctr"/><a:lstStyle/><a:p><a:endParaRPr lang="${safeLang}" dirty="0"/></a:p></p:txBody></p:sp>`;
    return `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${groupId}" name="Metric card ${groupId}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm>${frame}<a:chOff x="${x}" y="${cardY}"/><a:chExt cx="${cardWidth}" cy="${cardHeight}"/></a:xfrm></p:grpSpPr>${card}${rule}</p:grpSp>`;
  });
}
