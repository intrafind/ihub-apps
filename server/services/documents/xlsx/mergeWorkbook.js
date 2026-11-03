// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import {
  ContentTypes,
  NS,
  REL_TYPES,
  childElements,
  firstChild,
  nextRelId,
  openPackage,
  readRels,
  readXmlPart,
  relativeTarget,
  relsPathOf,
  removeUnreachableParts,
  resolveTarget,
  writePackage,
  writeRels,
  writeXmlPart
} from '../ooxml/opcPackage.js';
import { DocumentGenerationError } from '../renderService.js';
import { buildXlsx } from './buildXlsx.js';

/**
 * Add generated worksheets to an uploaded workbook.
 *
 * The uploaded `.xlsx` keeps everything it has (its sheets, styles, defined
 * names, charts, …); the sheets of the spec are written with `buildXlsx` and
 * merged in:
 *
 * - a sheet with the name of an existing one (case-insensitive) replaces it
 *   in place; any other sheet is appended;
 * - the generated cell styles are appended to the workbook's style sheet and
 *   the cells re-pointed to them, so neither side's formatting changes;
 * - the calculation chain is dropped and `fullCalcOnLoad` set, so Excel
 *   recalculates every formula when the file is opened.
 */

const WORKSHEET_REL =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';
const CALC_CHAIN_REL =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain';
const WORKSHEET_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';
const STYLES_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml';
const SML_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

/** Workbook children that come before `calcPr` (schema order). */
const BEFORE_CALC_PR = ['sheets', 'functionGroups', 'externalReferences', 'definedNames'];

async function mainPartOf(zip) {
  const rel = (await readRels(zip, '')).find(r => r.type === REL_TYPES.officeDocument);
  return rel ? resolveTarget('', rel.target) : 'xl/workbook.xml';
}

function relIdOf(sheet) {
  return sheet.getAttributeNS(NS.r, 'id') || sheet.getAttribute('r:id');
}

function setCount(element) {
  element.setAttribute('count', String(childElements(element).length));
}

function uniquePart(zip, pattern) {
  for (let n = 1; ; n += 1) {
    const candidate = pattern.replace('{n}', String(n));
    if (!zip.file(candidate)) return candidate;
  }
}

/**
 * Append the generated style sheet to the workbook's.
 *
 * @returns {Map<number, number>} Generated cell style index → workbook index.
 */
function mergeStyles(srcDoc, genDoc) {
  const srcRoot = srcDoc.documentElement;
  const genRoot = genDoc.documentElement;
  const ensure = name => {
    let element = firstChild(srcRoot, name);
    if (!element) {
      element = srcDoc.createElementNS(SML_NS, name);
      // Schema order: numFmts, fonts, fills, borders, cellStyleXfs, cellXfs, …
      const order = ['numFmts', 'fonts', 'fills', 'borders', 'cellStyleXfs', 'cellXfs'];
      const later = order.slice(order.indexOf(name) + 1);
      const anchor = childElements(srcRoot).find(child => later.includes(child.localName));
      if (anchor) srcRoot.insertBefore(element, anchor);
      else srcRoot.appendChild(element);
    }
    return element;
  };

  const srcNumFmts = ensure('numFmts');
  let nextNumFmtId = 164;
  for (const fmt of childElements(srcNumFmts, 'numFmt')) {
    nextNumFmtId = Math.max(nextNumFmtId, Number(fmt.getAttribute('numFmtId')) + 1);
  }
  const numFmtMap = new Map();
  for (const fmt of childElements(firstChild(genRoot, 'numFmts'), 'numFmt')) {
    const copy = srcDoc.importNode(fmt, true);
    const newId = nextNumFmtId;
    nextNumFmtId += 1;
    numFmtMap.set(Number(fmt.getAttribute('numFmtId')), newId);
    copy.setAttribute('numFmtId', String(newId));
    srcNumFmts.appendChild(copy);
  }
  setCount(srcNumFmts);
  if (childElements(srcNumFmts).length === 0) srcRoot.removeChild(srcNumFmts);

  const offsets = {};
  for (const [name, item] of [
    ['fonts', 'font'],
    ['fills', 'fill'],
    ['borders', 'border']
  ]) {
    const target = ensure(name);
    offsets[name] = childElements(target, item).length;
    for (const child of childElements(firstChild(genRoot, name), item)) {
      target.appendChild(srcDoc.importNode(child, true));
    }
    setCount(target);
  }

  const cellXfs = ensure('cellXfs');
  const xfBase = childElements(cellXfs, 'xf').length;
  const xfMap = new Map();
  childElements(firstChild(genRoot, 'cellXfs'), 'xf').forEach((xf, index) => {
    const copy = srcDoc.importNode(xf, true);
    const numFmtId = Number(copy.getAttribute('numFmtId')) || 0;
    if (numFmtMap.has(numFmtId)) copy.setAttribute('numFmtId', String(numFmtMap.get(numFmtId)));
    copy.setAttribute('fontId', String(Number(copy.getAttribute('fontId') || 0) + offsets.fonts));
    copy.setAttribute('fillId', String(Number(copy.getAttribute('fillId') || 0) + offsets.fills));
    copy.setAttribute(
      'borderId',
      String(Number(copy.getAttribute('borderId') || 0) + offsets.borders)
    );
    copy.setAttribute('xfId', '0');
    // Every generated style names its font, fill and border itself.
    for (const flag of ['applyFont', 'applyFill', 'applyBorder']) copy.setAttribute(flag, '1');
    cellXfs.appendChild(copy);
    xfMap.set(index, xfBase + index);
  });
  setCount(cellXfs);
  return xfMap;
}

function remapCellStyles(xml, xfMap) {
  return xml.replace(/<c\b[^>]*>/g, tag =>
    tag.replace(/(\ss=")(\d+)(")/, (match, pre, index, post) => {
      const mapped = xfMap.get(Number(index));
      return mapped === undefined ? match : `${pre}${mapped}${post}`;
    })
  );
}

/**
 * Merge a generated workbook spec into an uploaded workbook.
 *
 * @param {Buffer|Uint8Array} sourceBuffer - The uploaded `.xlsx`.
 * @param {Object} spec - A workbook spec (see `buildXlsx.js`).
 * @returns {Promise<{ buffer: Buffer, sheets: number, added: string[], replaced: string[], warnings: string[] }>}
 */
export async function mergeIntoWorkbook(sourceBuffer, spec) {
  let src;
  try {
    src = await openPackage(sourceBuffer);
  } catch (error) {
    throw new DocumentGenerationError(
      error?.message || 'The uploaded file is not a valid Excel workbook.',
      'invalid'
    );
  }
  const built = await buildXlsx(spec);
  const gen = await openPackage(built.buffer);

  const srcMain = await mainPartOf(src);
  const genMain = await mainPartOf(gen);
  const srcWorkbook = await readXmlPart(src, srcMain);
  if (!srcWorkbook || !firstChild(srcWorkbook.documentElement, 'sheets')) {
    throw new DocumentGenerationError(
      'The uploaded file is not a valid Excel workbook.',
      'invalid'
    );
  }
  const genWorkbook = await readXmlPart(gen, genMain);
  const srcRels = await readRels(src, srcMain);
  const genRels = await readRels(gen, genMain);
  const types = await ContentTypes.read(src);

  // Styles.
  const srcStylesRel = srcRels.find(r => r.type === REL_TYPES.styles);
  const genStylesRel = genRels.find(r => r.type === REL_TYPES.styles);
  let xfMap = new Map();
  if (genStylesRel) {
    const genStyles = await readXmlPart(gen, resolveTarget(genMain, genStylesRel.target));
    if (srcStylesRel) {
      const stylesPath = resolveTarget(srcMain, srcStylesRel.target);
      const srcStyles = await readXmlPart(src, stylesPath);
      xfMap = mergeStyles(srcStyles, genStyles);
      writeXmlPart(src, stylesPath, srcStyles);
    } else {
      const stylesPath = 'xl/styles.xml';
      writeXmlPart(src, stylesPath, genStyles);
      srcRels.push({
        id: nextRelId(srcRels),
        type: REL_TYPES.styles,
        target: relativeTarget(srcMain, stylesPath)
      });
      types.setOverride(stylesPath, STYLES_TYPE);
      childElements(firstChild(genStyles.documentElement, 'cellXfs'), 'xf').forEach((_, i) =>
        xfMap.set(i, i)
      );
    }
  }

  // Sheets.
  const srcSheets = firstChild(srcWorkbook.documentElement, 'sheets');
  const existing = new Map();
  let maxSheetId = 0;
  for (const sheet of childElements(srcSheets, 'sheet')) {
    existing.set(String(sheet.getAttribute('name')).toLowerCase(), sheet);
    maxSheetId = Math.max(maxSheetId, Number(sheet.getAttribute('sheetId')) || 0);
  }
  const added = [];
  const replaced = [];
  const genSheets = childElements(firstChild(genWorkbook.documentElement, 'sheets'), 'sheet');
  for (const genSheet of genSheets) {
    const name = genSheet.getAttribute('name');
    const genRel = genRels.find(r => r.id === relIdOf(genSheet));
    if (!genRel) continue;
    const genPath = resolveTarget(genMain, genRel.target);
    const xml = remapCellStyles(await gen.file(genPath).async('string'), xfMap);
    const match = existing.get(String(name).toLowerCase());
    if (match) {
      const srcRel = srcRels.find(r => r.id === relIdOf(match));
      if (srcRel) {
        const partPath = resolveTarget(srcMain, srcRel.target);
        src.file(partPath, xml);
        // The old sheet's drawings, tables and comments belong to cells that
        // are gone now.
        src.remove(relsPathOf(partPath));
        replaced.push(String(match.getAttribute('name')));
        continue;
      }
    }
    const partPath = uniquePart(src, 'xl/worksheets/sheet{n}.xml');
    src.file(partPath, xml);
    types.setOverride(partPath, WORKSHEET_TYPE);
    const relId = nextRelId(srcRels);
    srcRels.push({ id: relId, type: WORKSHEET_REL, target: relativeTarget(srcMain, partPath) });
    maxSheetId += 1;
    const entry = srcWorkbook.createElementNS(SML_NS, 'sheet');
    entry.setAttribute('name', name);
    entry.setAttribute('sheetId', String(maxSheetId));
    entry.setAttributeNS(NS.r, 'r:id', relId);
    srcSheets.appendChild(entry);
    added.push(name);
  }

  // Formulas are recalculated on open; a stale calculation chain would make
  // Excel report the file as damaged.
  for (const rel of srcRels.filter(r => r.type === CALC_CHAIN_REL)) {
    const partPath = resolveTarget(srcMain, rel.target);
    src.remove(partPath);
    types.removeOverride(partPath);
  }
  const keptRels = srcRels.filter(r => r.type !== CALC_CHAIN_REL);
  const root = srcWorkbook.documentElement;
  let calcPr = firstChild(root, 'calcPr');
  if (!calcPr) {
    calcPr = srcWorkbook.createElementNS(SML_NS, 'calcPr');
    const anchor = childElements(root)
      .filter(child => BEFORE_CALC_PR.includes(child.localName))
      .at(-1);
    if (anchor) root.insertBefore(calcPr, anchor.nextSibling);
    else root.appendChild(calcPr);
  }
  calcPr.setAttribute('fullCalcOnLoad', '1');
  writeXmlPart(src, srcMain, srcWorkbook);
  writeRels(src, srcMain, keptRels);

  await removeUnreachableParts(src, types);
  types.write(src);
  return {
    buffer: await writePackage(src),
    sheets: childElements(srcSheets, 'sheet').length,
    added,
    replaced,
    warnings: built.warnings
  };
}
