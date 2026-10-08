/**
 * List and chapter numbers of an OpenDocument text: Writer stores them as list styles and
 * counts them when it lays the document out. The labels are computed here — numbered lists,
 * numbered headings inside lists, and chapter numbering through the outline style — with the
 * counting rules of ODF (restart per list, `text:continue-list`, `text:continue-numbering`,
 * `text:start-value`, `text:style-override`, `text:list-header`).
 *
 * A label is only written when it can be computed with certainty: a wrong number is worse than
 * none (the same rule as the Word numbering).
 *
 * @module shared/documentExtraction/odf/lists
 */
import { formatNumber } from '../ooxml/numbering.js';
import { all, attr, kids } from './xml.js';

const MAX_START = 1000000;

// ODF `style:num-format` → the format names of the Word numbering.
const FORMATS = {
  1: 'decimal',
  a: 'lowerLetter',
  A: 'upperLetter',
  i: 'lowerRoman',
  I: 'upperRoman'
};

function readLevels(styleEl, levelNames) {
  const levels = new Map();
  for (const level of kids(styleEl)) {
    if (!levelNames.has(level.localName)) continue;
    const number = Number(attr(level, 'text', 'level'));
    if (!Number.isInteger(number) || number < 1 || number > 10) continue;
    const isNumber =
      level.localName !== 'list-level-style-bullet' && level.localName !== 'list-level-style-image';
    const format = attr(level, 'style', 'num-format');
    const start = Number(attr(level, 'text', 'start-value') ?? 1);
    levels.set(number, {
      bullet: !isNumber && level.localName === 'list-level-style-bullet',
      // `style:num-format=""` is a level without a number
      format: isNumber ? (format === undefined ? '' : format) : null,
      prefix: attr(level, 'style', 'num-prefix') ?? '',
      suffix: attr(level, 'style', 'num-suffix') ?? '',
      displayLevels: Math.min(
        Math.max(Number(attr(level, 'text', 'display-levels') ?? 1) || 1, 1),
        10
      ),
      start: Number.isInteger(start) && start >= 0 && start <= MAX_START ? start : 1,
      letterSync: attr(level, 'style', 'num-letter-sync')
    });
  }
  return levels;
}

const LIST_LEVELS = new Set([
  'list-level-style-number',
  'list-level-style-bullet',
  'list-level-style-image'
]);
const OUTLINE_LEVELS = new Set(['outline-level-style']);

/**
 * The list styles (`text:list-style`) of both documents by name, and the outline style of the
 * chapter numbering.
 *
 * @param {Document|null} contentDoc
 * @param {Document|null} stylesDoc
 */
export function readListStyles(contentDoc, stylesDoc) {
  const lists = new Map();
  for (const doc of [stylesDoc, contentDoc]) {
    for (const style of all(doc, 'text', 'list-style')) {
      const name = attr(style, 'style', 'name');
      if (name) lists.set(name, readLevels(style, LIST_LEVELS));
    }
  }
  const outlineEl = all(stylesDoc, 'text', 'outline-style')[0];
  return {
    lists,
    outline: outlineEl
      ? {
          name: attr(outlineEl, 'style', 'name') ?? 'Outline',
          levels: readLevels(outlineEl, OUTLINE_LEVELS)
        }
      : null
  };
}

/**
 * One counter of a level as text. `null` when it cannot be said for sure.
 */
function formatCounter(value, definition) {
  if (!definition || definition.format === null || definition.format === '') return '';
  const format = FORMATS[definition.format];
  if (!format) return null;
  // Past `z` the letter sequence depends on `style:num-letter-sync`: only the repeated-letter
  // sequence (aa, bb, …) of the default is known to match what Writer shows.
  if ((format === 'lowerLetter' || format === 'upperLetter') && value > 26) {
    return definition.letterSync === 'false' ? null : formatNumber(value, format);
  }
  return formatNumber(value, format);
}

/** Counters and labels. One instance per document. */
export function createNumbering({ lists, outline }) {
  const chains = new Map(); // xml:id → { counters }
  let previous = null; // the list before the current one: { styleName, chain }
  const outlineChain = { counters: [] };

  /** Label of the counter state `chain` at `level`, by the level definitions `levels`. */
  const label = (chain, level, levels) => {
    const definition = levels.get(level);
    const shown = [];
    for (let at = Math.max(1, level - definition.displayLevels + 1); at <= level; at += 1) {
      const shownLevel = levels.get(at);
      // A level in between that has no number (a bullet, none) leaves a gap in the label that
      // Writer fills in its own way (`.1.a`): not a label we can vouch for.
      if (!shownLevel || shownLevel.format === null || shownLevel.format === '') return null;
      const text = formatCounter(chain.counters[at - 1] ?? shownLevel.start ?? 1, shownLevel);
      if (text === null) return null;
      shown.push(text);
    }
    return `${definition.prefix}${shown.join('.')}${definition.suffix}`;
  };

  /** Advance the counter of `level`; `startValue` sets it. */
  const advance = (chain, level, definition, startValue) => {
    chain.counters.length = Math.min(chain.counters.length, level);
    const start = Number(startValue);
    if (startValue !== undefined && Number.isInteger(start) && start >= 0 && start <= MAX_START) {
      chain.counters[level - 1] = start;
    } else {
      const current = chain.counters[level - 1];
      chain.counters[level - 1] = current === undefined ? definition.start : current + 1;
    }
  };

  return {
    /** Context for walking a `text:list`; `parent` is the context of the enclosing list. */
    enterList(listEl, parent) {
      const styleName = attr(listEl, 'text', 'style-name') ?? parent?.styleName;
      if (parent) {
        return {
          chain: parent.chain,
          styleName,
          level: parent.level + 1,
          styles: [...parent.styles, styleName]
        };
      }
      let chain;
      const continued = attr(listEl, 'text', 'continue-list');
      if (continued && chains.has(continued)) chain = chains.get(continued);
      else if (
        attr(listEl, 'text', 'continue-numbering') === 'true' &&
        previous &&
        previous.styleName === styleName
      ) {
        // continues the list right before it, and only when that one has the same list style
        chain = previous.chain;
      } else chain = { counters: [] };
      const id = attr(listEl, 'xml', 'id');
      if (id) chains.set(id, chain);
      previous = { styleName, chain };
      // A list with a header item: Writer counts around it in a way that depends on where it
      // sits (checked against Writer), so such a list gets no numbers.
      if (all(listEl, 'text', 'list-header').length > 0) chain.unsupported = true;
      return { chain, styleName, level: 1, styles: [styleName] };
    },

    /**
     * What a list item shows: `{ bullet: true }`, `{ label }` (may be '' for no number) or
     * `null` when the item takes no number (a list header).
     */
    item(context, itemEl) {
      if (itemEl.localName === 'list-header') return null;
      const styleName = attr(itemEl, 'text', 'style-override') ?? context.styleName;
      const levels = lists.get(styleName);
      const definition = levels?.get(context.level);
      // Every item counts — also those of a level without a number: a list that continues
      // another one (or switches style) goes on from the count, not from what was shown.
      advance(
        context.chain,
        context.level,
        definition ?? { start: 1 },
        attr(itemEl, 'text', 'start-value')
      );
      if (!definition) return { label: '' };
      if (definition.bullet || definition.format === null) return { bullet: true };
      // Not vouched for (they differ from Writer's counting in the cases checked): lists with a
      // header item, an overridden style anywhere but at the first level or together with a start
      // value, and labels that show several levels when the levels belong to lists of different
      // styles.
      const overridden = attr(itemEl, 'text', 'style-override') !== undefined;
      const restarted = overridden && attr(itemEl, 'text', 'start-value') !== undefined;
      const mixedStyles =
        definition.displayLevels > 1 &&
        context.styles
          .slice(Math.max(0, context.level - definition.displayLevels), context.level - 1)
          .some(name => name !== styleName);
      // The counting after such an item is not known either.
      if (restarted) context.chain.unsupported = true;
      if (
        context.chain.unsupported ||
        (overridden && (context.level !== 1 || definition.displayLevels > 1)) ||
        mixedStyles
      ) {
        return { label: '' };
      }
      const text = label(context.chain, context.level, levels);
      return text === null ? { label: '' } : { label: text };
    },

    /**
     * The chapter number of a heading outside any list: only when its paragraph style is bound
     * to the outline style and that level has a number format. `null` otherwise.
     */
    heading(headingEl, level, listStyleName) {
      if (!outline || listStyleName !== outline.name) return null;
      if (attr(headingEl, 'text', 'is-list-header') === 'true') return null;
      const definition = outline.levels.get(level);
      if (!definition || definition.format === null || definition.format === '') return null;
      advance(outlineChain, level, definition, attr(headingEl, 'text', 'start-value'));
      const text = label(outlineChain, level, outline.levels);
      return text === null || text === '' ? null : text;
    }
  };
}
