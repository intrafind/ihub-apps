// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import {
  openPackage,
  readRels,
  readXmlPart,
  REL_TYPES,
  resolveTarget
} from '../ooxml/opcPackage.js';
import { DEFAULT_COLORS } from '../pptx/baseTemplate.js';
import { themeOf } from '../pptx/pptxTemplate.js';
import { isColourfulAccent } from '../pptx/pptxXml.js';

/**
 * The brand of a document template: colours, a chart palette and fonts.
 *
 * A company's design lives in its Word and PowerPoint files, so the brand is
 * read from their themes. A template's own colours (`brand.primaryColor`,
 * `accentColor`, `textColor`) are overrides; what they leave open is taken
 * from the PowerPoint theme, then the Word theme, then a neutral default.
 *
 * See `concepts/2026-11-24 Document Templates Rework.md`.
 */

const PRESENTATION = 'ppt/presentation.xml';
const ACCENT_ROLES = ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'];

/** The palette has at most this many colours. */
export const PALETTE_SIZE = 6;

/**
 * Two accents differ clearly when their RGB distance is at least this much
 * (of 441 for black against white). The accent colour is the next accent
 * that differs from the primary colour by this much.
 */
const MIN_ACCENT_DISTANCE = 64;

/** Which of the brand's fields come from where, for the admin page. */
export const BRAND_SOURCES = Object.freeze(['template', 'powerpoint', 'word', 'default']);

function hexOf(value) {
  const hex = String(value || '').replace('#', '');
  return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toUpperCase()}` : null;
}

function distance(a, b) {
  const rgb = hex => [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16));
  const [x, y] = [rgb(a), rgb(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

/**
 * The brand a theme stands for.
 *
 * - **Primary** is the first accent that is a real colour, not a grey, so a
 *   theme whose accent 1 is grey still gives a colourful primary.
 * - **Accent** is the next accent after the primary that clearly differs
 *   from it; it may be a grey.
 * - **Palette** is accents 1 to 6, the greys last.
 * - **Text** is `dk1`.
 * - **Fonts** are the theme's heading (major) and body (minor) fonts.
 *
 * A theme without a colourful accent gives no primary, accent or palette, so
 * the next source is tried; its text colour and fonts still count.
 *
 * @param {Object} theme
 * @param {Object<string, string>} [theme.colors] - Colours by role (`dk1`, `accent1` …).
 * @param {{ major?: string, minor?: string }} [theme.fonts]
 * @returns {{ primaryColor?: string, accentColor?: string, textColor?: string,
 *   palette?: string[], headingFont?: string, bodyFont?: string }}
 */
export function brandFromTheme({ colors = {}, fonts = {} } = {}) {
  const accents = ACCENT_ROLES.map(role => hexOf(colors[role])).filter(Boolean);
  const colourful = accents.filter(isColourfulAccent);
  const brand = {};
  if (colourful.length) {
    const [primary] = colourful;
    brand.primaryColor = primary;
    // The accent is the next accent after the primary that clearly differs
    // from it, going round to the accents before it.
    const at = accents.indexOf(primary);
    const accent = [...accents.slice(at + 1), ...accents.slice(0, at)].find(
      color => distance(color, primary) >= MIN_ACCENT_DISTANCE
    );
    if (accent) brand.accentColor = accent;
    const greys = accents.filter(color => !isColourfulAccent(color));
    brand.palette = [...new Set([...colourful, ...greys])].slice(0, PALETTE_SIZE);
  }
  const text = hexOf(colors.dk1);
  if (text) brand.textColor = text;
  if (fonts.major) brand.headingFont = fonts.major;
  if (fonts.minor) brand.bodyFont = fonts.minor;
  return brand;
}

async function themePartOf(zip, ownerPart) {
  const rel = (await readRels(zip, ownerPart)).find(r => r.type === REL_TYPES.theme);
  return rel ? resolveTarget(ownerPart, rel.target) : null;
}

/**
 * The part of a presentation that holds its theme: the first slide master's,
 * else the presentation's own.
 */
async function presentationThemePart(zip) {
  const rels = await readRels(zip, PRESENTATION);
  const master = rels.find(r => r.type === REL_TYPES.slideMaster);
  const fromMaster = master
    ? await themePartOf(zip, resolveTarget(PRESENTATION, master.target))
    : null;
  return fromMaster || themePartOf(zip, PRESENTATION);
}

async function documentThemePart(zip) {
  const root = (await readRels(zip, '')).find(r => r.type === REL_TYPES.officeDocument);
  return themePartOf(zip, root ? resolveTarget('', root.target) : 'word/document.xml');
}

/**
 * The brand of one Office file, from its theme alone: what the "take colours
 * from this file" action copies, whatever overrides the template has.
 *
 * @param {Buffer|Uint8Array} buffer - A `.pptx`, `.potx`, `.docx` or `.dotx`.
 * @param {'pptx'|'docx'} format
 * @returns {Promise<ReturnType<typeof brandFromTheme> | null>} null when the
 *   file has no theme.
 */
export async function readThemeBrand(buffer, format) {
  const zip = await openPackage(buffer);
  const part = format === 'pptx' ? await presentationThemePart(zip) : await documentThemePart(zip);
  const doc = part ? await readXmlPart(zip, part) : null;
  return doc ? brandFromTheme(themeOf(doc)) : null;
}

const COLOR_FIELDS = Object.freeze({
  primaryColor: DEFAULT_COLORS.primary,
  accentColor: DEFAULT_COLORS.accent,
  textColor: DEFAULT_COLORS.text
});

/**
 * The brand a document gets: each field from the template's own value, else
 * the PowerPoint theme, else the Word theme, else the neutral default.
 *
 * @param {Object} params
 * @param {Object} [params.brand] - The template's `brand`.
 * @param {Array<{ source: 'powerpoint'|'word', brand: Object }>} [params.themes] -
 *   Theme brands in the order they are tried.
 * @returns {{ primaryColor: string, accentColor: string, textColor: string,
 *   palette: string[], headingFont?: string, bodyFont?: string,
 *   sources: Object<string, 'template'|'powerpoint'|'word'|'default'> }}
 */
export function resolveBrand({ brand = {}, themes = [] } = {}) {
  const resolved = { sources: {} };
  /** Set a field from its own value, else the first theme that has one, else the default. */
  const take = (field, own, fallback) => {
    if (own) {
      resolved[field] = own;
      resolved.sources[field] = 'template';
      return;
    }
    for (const theme of themes) {
      if (theme.brand?.[field] !== undefined) {
        resolved[field] = theme.brand[field];
        resolved.sources[field] = theme.source;
        return;
      }
    }
    if (fallback !== undefined) {
      resolved[field] = fallback;
      resolved.sources[field] = 'default';
    }
  };
  for (const [field, fallback] of Object.entries(COLOR_FIELDS)) {
    take(field, hexOf(brand[field]), `#${fallback}`);
  }
  take('palette', null, [
    `#${DEFAULT_COLORS.primary}`,
    `#${DEFAULT_COLORS.accent}`,
    ...DEFAULT_COLORS.palette.map(color => `#${color}`)
  ]);
  // A template's own fonts are still read while the settings exist; the
  // rework removes them and leaves the themes' fonts.
  take('headingFont', brand.headingFont || null, undefined);
  take('bodyFont', brand.bodyFont || null, undefined);
  return resolved;
}

/**
 * The resolved values that come from the template or a theme, without the
 * neutral defaults: what may override a request's own colours.
 *
 * @param {ReturnType<typeof resolveBrand>} [resolved]
 * @returns {Object}
 */
export function specifiedBrand(resolved) {
  const out = {};
  for (const [field, source] of Object.entries(resolved?.sources || {})) {
    if (source !== 'default') out[field] = resolved[field];
  }
  return out;
}

/** Points of a length in twips (Word's unit), within the margin limits. */
function pointsOf(twips) {
  return Math.min(200, Math.max(18, Math.round(twips / 20)));
}

/**
 * PDF margins from a Word template's last section, as `[left, top, right,
 * bottom]` in points.
 *
 * @param {{ margins: { left: number, top: number, right: number, bottom: number } }} setup -
 *   The page setup read from the Word template (twips).
 * @returns {[number, number, number, number]}
 */
export function pdfMarginsFromWordSetup(setup) {
  const { left, top, right, bottom } = setup.margins;
  return [pointsOf(left), pointsOf(top), pointsOf(right), pointsOf(bottom)];
}
