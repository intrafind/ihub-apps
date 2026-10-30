// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { createRequire } from 'node:module';
import JSZip from 'jszip';
import { INVALID_XML_CHARS, REL_TYPES, readRels, resolveTarget } from '../ooxml/opcPackage.js';
import { EMU_PER_INCH } from './pptxXml.js';

/**
 * Native PowerPoint charts (editable in PowerPoint, with their data in an
 * embedded workbook).
 *
 * pptxgenjs writes the chart parts: it renders every chart of a presentation
 * onto a slide of a scratch presentation of the same size, at the position it
 * will have. `buildPptx.js` then moves each chart part, its workbook and its
 * frame onto the real slide. Colours are the template's theme accents and the
 * labels use its body font, so charts match the deck.
 *
 * Only data reaches pptxgenjs: numbers and short strings. Nothing is read
 * from disk or fetched.
 */

const require = createRequire(import.meta.url);
const PptxGenJS = require('pptxgenjs');

export const CHART_TYPES = Object.freeze(['bar', 'column', 'line', 'pie', 'doughnut', 'area']);

export const CHART_LIMITS = Object.freeze({
  maxSeries: 12,
  maxCategories: 60,
  maxLabelChars: 80
});

/**
 * Check and normalise a chart from the model.
 *
 * @param {unknown} chart
 * @param {string[]} warnings
 * @returns {Object|null}
 */
export function sanitizeChart(chart, warnings) {
  if (!chart || typeof chart !== 'object') return null;
  const type = CHART_TYPES.includes(chart.type) ? chart.type : 'column';
  // pptxgenjs escapes markup but passes control characters through, which
  // XML (the chart part, its workbook) cannot hold.
  const clean = value => String(value ?? '').replace(INVALID_XML_CHARS, '');
  const label = value => clean(value).slice(0, CHART_LIMITS.maxLabelChars);
  const categories = Array.isArray(chart.categories)
    ? chart.categories.slice(0, CHART_LIMITS.maxCategories).map(label)
    : [];
  const series = (Array.isArray(chart.series) ? chart.series : [])
    .slice(0, CHART_LIMITS.maxSeries)
    .map((s, i) => ({
      name: label(s?.name || `Series ${i + 1}`),
      values: categories.map((_, c) => {
        const value = Number(Array.isArray(s?.values) ? s.values[c] : undefined);
        return Number.isFinite(value) ? value : 0;
      })
    }))
    .filter(s => s.values.length);
  if (!categories.length || !series.length) {
    warnings.push('A chart was skipped: it needs "categories" and at least one series of values.');
    return null;
  }
  return {
    type,
    title: typeof chart.title === 'string' ? clean(chart.title).slice(0, 200) : undefined,
    categories,
    series: type === 'pie' || type === 'doughnut' ? series.slice(0, 1) : series,
    stacked: chart.stacked === true && ['bar', 'column', 'area'].includes(type),
    showValues: chart.showValues === true,
    numberFormat:
      typeof chart.numberFormat === 'string' ? chart.numberFormat.slice(0, 40) : undefined
  };
}

function chartOptions(chart, rect, { colors, font }) {
  const inches = value => value / EMU_PER_INCH;
  const pie = chart.type === 'pie' || chart.type === 'doughnut';
  const options = {
    x: inches(rect.x),
    y: inches(rect.y),
    w: inches(rect.cx),
    h: inches(rect.cy),
    chartColors: colors,
    showLegend: pie || chart.series.length > 1,
    legendPos: 'b',
    legendFontFace: font,
    legendFontSize: 12,
    showTitle: Boolean(chart.title),
    ...(chart.title ? { title: chart.title, titleFontFace: font, titleFontSize: 14 } : {}),
    showValue: chart.showValues,
    dataLabelFontFace: font,
    dataLabelFontSize: 11,
    // Pie and doughnut labels show percentages: keep a percent format there.
    dataLabelFormatCode: pie
      ? chart.numberFormat?.includes('%')
        ? chart.numberFormat
        : '0%'
      : chart.numberFormat || 'General'
  };
  if (pie) {
    options.showPercent = chart.showValues;
    options.showValue = false;
    if (chart.type === 'doughnut') options.holeSize = 55;
    return options;
  }
  return {
    ...options,
    catAxisLabelFontFace: font,
    catAxisLabelFontSize: 12,
    valAxisLabelFontFace: font,
    valAxisLabelFontSize: 11,
    valGridLine: { color: 'D9D9D9', size: 0.5 },
    catGridLine: { style: 'none' },
    ...(chart.numberFormat ? { valAxisLabelFormatCode: chart.numberFormat } : {}),
    ...(chart.type === 'bar' ? { barDir: 'bar' } : {}),
    ...(chart.type === 'column' ? { barDir: 'col' } : {}),
    ...(chart.stacked ? { barGrouping: 'stacked' } : {}),
    ...(chart.type === 'line'
      ? { lineSize: 2.5, lineDataSymbol: 'circle', lineDataSymbolSize: 7 }
      : {})
  };
}

function typeFor(pptx, chart) {
  return {
    bar: pptx.ChartType.bar,
    column: pptx.ChartType.bar,
    line: pptx.ChartType.line,
    pie: pptx.ChartType.pie,
    doughnut: pptx.ChartType.doughnut,
    area: pptx.ChartType.area
  }[chart.type];
}

/**
 * Render charts with pptxgenjs and return their parts.
 *
 * @param {Array<{ chart: Object, rect: Object }>} requests - Sanitised
 *   charts with their place on the slide (EMU).
 * @param {Object} options
 * @param {{ cx: number, cy: number }} options.slideSize
 * @param {string[]} options.colors - Hex colours (theme accents).
 * @param {string} options.font - Label font.
 * @returns {Promise<Array<{ chartXml: string, workbook: Buffer|null, frameXml: string }>>}
 */
export async function renderCharts(requests, { slideSize, colors, font }) {
  if (!requests.length) return [];
  const pptx = new PptxGenJS();
  pptx.defineLayout({
    name: 'IHUB',
    width: slideSize.cx / EMU_PER_INCH,
    height: slideSize.cy / EMU_PER_INCH
  });
  pptx.layout = 'IHUB';
  for (const { chart, rect } of requests) {
    const slide = pptx.addSlide();
    slide.addChart(
      typeFor(pptx, chart),
      chart.series.map(s => ({ name: s.name, labels: chart.categories, values: s.values })),
      chartOptions(chart, rect, { colors, font })
    );
  }
  const zip = await JSZip.loadAsync(await pptx.write({ outputType: 'nodebuffer' }));
  const out = [];
  for (let i = 1; i <= requests.length; i += 1) {
    const slidePath = `ppt/slides/slide${i}.xml`;
    const slideXml = await zip.file(slidePath).async('string');
    const chartRel = (await readRels(zip, slidePath)).find(r => r.type === REL_TYPES.chart);
    const chartPath = chartRel ? resolveTarget(slidePath, chartRel.target) : null;
    const frameStart = slideXml.indexOf('<p:graphicFrame>');
    const frameEnd = slideXml.indexOf('</p:graphicFrame>', frameStart);
    const chartFile = chartPath ? zip.file(chartPath) : null;
    if (frameStart < 0 || frameEnd < 0 || !chartFile) {
      throw new Error('A chart could not be created.');
    }
    const workbookRel = (await readRels(zip, chartPath)).find(r => r.type === REL_TYPES.package);
    const workbookFile = workbookRel
      ? zip.file(resolveTarget(chartPath, workbookRel.target))
      : null;
    out.push({
      chartXml: await chartFile.async('string'),
      workbook: workbookFile ? await workbookFile.async('nodebuffer') : null,
      frameXml: slideXml.slice(frameStart, frameEnd + '</p:graphicFrame>'.length)
    });
  }
  return out;
}
