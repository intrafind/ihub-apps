// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { getLocalizedString } from '../../../utils/localize.js';

/**
 * What the model is told about the slide template: which text slots a slide
 * can fill besides its title and content, where each one is, how much text
 * fits, and what the slide types (`layout` values) offer. Built from the
 * analysis of the template (`analyzePowerpointTemplate`), so the model fills
 * what the template has and puts nothing where it has no place.
 */

const KIND_LAYOUT_VALUE = {
  title: 'title',
  section: 'section',
  content: 'content',
  twoColumn: 'two-column',
  titleOnly: 'title-only',
  blank: 'blank'
};

const KIND_ORDER = ['title', 'section', 'content', 'twoColumn', 'titleOnly'];

const TEXT = {
  en: {
    intro:
      'The slide template has text slots besides title and content. Fill them with the slide field "slots", an object of text by slot id, and use only these ids:',
    above: 'Above the title.',
    below: 'Below the title.',
    at: (v, h) =>
      `${{ top: 'At the top', middle: 'In the middle', bottom: 'At the bottom' }[v]}${h}.`,
    horizontal: { left: ' left', centre: ' centre', right: ' right' },
    fits: (lines, chars) =>
      `Fits ${lines === 1 ? 'one line' : `${lines} lines`}, about ${chars} characters.`,
    drop: 'Left out when the slide type has no such slot.',
    text: 'Becomes the first paragraph of the text when the slide type has no such slot.',
    kinds: 'Slide types ("layout") and what each has:',
    title: 'title',
    subtitle: 'subtitle',
    area: (w, h) => `text, table, chart or picture area (${w} × ${h} in)`,
    areas: (n, w, h) => `${n} content areas side by side (${w} × ${h} in each)`,
    slot: (id, where) => `slot "${id}" (${where})`,
    strip: text =>
      text
        ? `footer strip text (slide field "footer"; "${text}" if unset)`
        : 'footer strip text (slide field "footer")',
    decimal: '.',
    others: 'Other templates can differ.',
    where: { 'above-title': 'above the title', 'below-title': 'below the title' }
  },
  de: {
    intro:
      'Die Folienvorlage hat Textfelder neben Titel und Inhalt. Sie werden mit dem Folienfeld "slots" gefüllt, einem Objekt mit Text je Feld-ID; nur diese IDs verwenden:',
    above: 'Über dem Titel.',
    below: 'Unter dem Titel.',
    at: (v, h) => `${{ top: 'Oben', middle: 'In der Mitte', bottom: 'Unten' }[v]}${h}.`,
    horizontal: { left: ' links', centre: ' mittig', right: ' rechts' },
    fits: (lines, chars) =>
      `Passt ${lines === 1 ? 'eine Zeile' : `${lines} Zeilen`}, etwa ${chars} Zeichen.`,
    drop: 'Entfällt, wenn der Folientyp kein solches Feld hat.',
    text: 'Wird zum ersten Absatz des Textes, wenn der Folientyp kein solches Feld hat.',
    kinds: 'Folientypen ("layout") und was sie haben:',
    title: 'Titel',
    subtitle: 'Untertitel',
    area: (w, h) => `Bereich für Text, Tabelle, Diagramm oder Bild (${w} × ${h} in)`,
    areas: (n, w, h) => `${n} Inhaltsbereiche nebeneinander (je ${w} × ${h} in)`,
    slot: (id, where) => `Feld "${id}" (${where})`,
    strip: text =>
      text
        ? `Text im Fußzeilenstreifen (Folienfeld "footer"; "${text}", wenn leer)`
        : 'Text im Fußzeilenstreifen (Folienfeld "footer")',
    decimal: ',',
    others: 'Andere Vorlagen können abweichen.',
    where: { 'above-title': 'über dem Titel', 'below-title': 'unter dem Titel' }
  }
};

function phrases(language) {
  return TEXT[String(language || 'en').slice(0, 2)] || TEXT.en;
}

/** "above the title", "at the bottom right" … */
function whereOf(position, t) {
  if (t.where[position]) return t.where[position];
  const [vertical, horizontal] = position.split('-');
  return t
    .at(vertical, t.horizontal[horizontal] || '')
    .replace(/\.$/, '')
    .toLowerCase();
}

function sentenceWhere(position, t) {
  if (position === 'above-title') return t.above;
  if (position === 'below-title') return t.below;
  const [vertical, horizontal] = position.split('-');
  return t.at(vertical, t.horizontal[horizontal] || '');
}

function slotLine(slot, elements, t, language) {
  const element = elements.find(e => e.slot === slot.id);
  const description = getLocalizedString(slot.description, language) || '';
  const parts = [`- "${slot.id}":`];
  if (description) parts.push(description.replace(/\s+$/, ''));
  if (element) {
    parts.push(sentenceWhere(element.position, t));
    if (element.capacity) parts.push(t.fits(element.capacity.lines, element.capacity.chars));
  }
  parts.push(slot.ifMissing === 'text' ? t.text : t.drop);
  return parts.join(' ');
}

function sizeInches(element, t) {
  const format = value => String(Math.round(value * 10) / 10).replace('.', t.decimal);
  return [format(element.width), format(element.height)];
}

function kindLine(kind, analysis, t) {
  const layouts = analysis.layouts.filter(l => l.kind === kind);
  if (!layouts.length) return null;
  const base = layouts.find(l => l.name === analysis.mapping?.[kind]) || layouts[0];
  const parts = [];
  // On a title or section slide the text placeholder under the title is its subtitle.
  const headline = kind === 'title' || kind === 'section';
  if (base.elements.some(e => e.role === 'title')) parts.push(t.title);
  if (base.elements.some(e => e.role === 'subtitle' || (headline && e.role === 'content'))) {
    parts.push(t.subtitle);
  }
  const areas = headline ? [] : base.elements.filter(e => e.role === 'content');
  if (areas.length === 1) parts.push(t.area(...sizeInches(areas[0], t)));
  else if (areas.length > 1) parts.push(t.areas(areas.length, ...sizeInches(areas[0], t)));
  // Slots of any layout of the kind: the layout with the most of them serves the slide.
  const seen = new Set();
  for (const layout of layouts) {
    for (const element of layout.elements) {
      if (element.role !== 'slot' || seen.has(element.slot)) continue;
      seen.add(element.slot);
      parts.push(t.slot(element.slot, whereOf(element.position, t)));
    }
  }
  const strip =
    kind === 'title' &&
    [base, ...layouts].flatMap(l => l.elements).find(e => e.role === 'footer' && e.text);
  if (strip) parts.push(t.strip(strip.text));
  return parts.length ? `- ${KIND_LAYOUT_VALUE[kind]}: ${parts.join('; ')}` : null;
}

/**
 * The text that tells the model what the slide template offers.
 *
 * @param {Object} analysis - From `analyzePowerpointTemplate`.
 * @param {Object} [options]
 * @param {string} [options.language]
 * @param {boolean} [options.others] - Other templates can be chosen: say they can differ.
 * @returns {string} Empty when there is nothing to tell.
 */
export function buildSlideGuide(analysis, { language = 'en', others = false } = {}) {
  if (!analysis?.layouts?.length) return '';
  const t = phrases(language);
  const lines = [];
  const slots = (analysis.slots || []).filter(slot => slot.layouts.length);
  if (slots.length) {
    lines.push(t.intro);
    const elements = analysis.layouts.flatMap(layout => layout.elements);
    for (const slot of slots) lines.push(slotLine(slot, elements, t, language));
  }
  const kinds = KIND_ORDER.map(kind => kindLine(kind, analysis, t)).filter(Boolean);
  if (kinds.length) {
    lines.push(t.kinds, ...kinds);
  }
  if (!lines.length) return '';
  if (others) lines.push(t.others);
  return lines.join('\n');
}
