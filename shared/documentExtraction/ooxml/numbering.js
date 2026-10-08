/**
 * Word list numbering: the labels (`1.`, `1.1`, `a)`, `Teil I`, `§ 3`) Word computes from
 * numbering.xml and the paragraphs' list properties.
 *
 * The label is not stored as text in a .docx — mammoth only knows "this paragraph is a list item" —
 * so chapter and clause numbers are missing from extracted text unless they are computed here.
 * The rules follow Word and were checked against LibreOffice as an independent renderer
 * (see concepts/document-extraction/).
 *
 * Wrong numbers are worse than none: whenever a numbering feature is not implemented (a level
 * with `w:lvlRestart`), the paragraph gets no label.
 *
 * @module shared/documentExtraction/ooxml/numbering
 */

const toRoman = n => {
  const table = [
    [1000, 'm'],
    [900, 'cm'],
    [500, 'd'],
    [400, 'cd'],
    [100, 'c'],
    [90, 'xc'],
    [50, 'l'],
    [40, 'xl'],
    [10, 'x'],
    [9, 'ix'],
    [5, 'v'],
    [4, 'iv'],
    [1, 'i']
  ];
  let rest = n;
  let out = '';
  for (const [value, symbol] of table) {
    while (rest >= value) {
      out += symbol;
      rest -= value;
    }
  }
  return out;
};

/** a … z, aa … zz, aaa … (Word repeats the letter; it does not count in base 26). */
const toLetters = n => {
  const letter = String.fromCharCode(97 + ((n - 1) % 26));
  return letter.repeat(Math.floor((n - 1) / 26) + 1);
};

const toOrdinal = n => {
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`;
};

/**
 * A counter value in a Word number format. Formats not listed (`cardinalText`,
 * `chineseCounting`, `decimalEnclosedCircle`, …) count in plain decimals so the sequence stays
 * recognisable and nothing throws.
 *
 * @param {number} value
 * @param {string} [numFmt] - `w:numFmt` value
 * @returns {string}
 */
export function formatNumber(value, numFmt) {
  if (!Number.isFinite(value)) return '';
  switch (numFmt) {
    case 'decimalZero':
      return String(value).padStart(2, '0');
    case 'lowerLetter':
      return value >= 1 ? toLetters(value) : String(value);
    case 'upperLetter':
      return value >= 1 ? toLetters(value).toUpperCase() : String(value);
    case 'lowerRoman':
      return value >= 1 && value < 4000 ? toRoman(value) : String(value);
    case 'upperRoman':
      return value >= 1 && value < 4000 ? toRoman(value).toUpperCase() : String(value);
    case 'ordinal':
      return value >= 1 ? toOrdinal(value) : String(value);
    default:
      return String(value);
  }
}

const MAX_STYLE_LINK_DEPTH = 8;

/**
 * @param {Document|null} numberingDoc - Parsed word/numbering.xml, or null when the part is missing
 * @param {ReturnType<import('./styles.js').readStyles>} styles
 * @param {ReturnType<import('./xml.js').createWordXml>} xml
 */
export function createNumbering(numberingDoc, styles, xml) {
  const intVal = el => {
    const raw = xml.val(el);
    const n = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const readLevel = lvl => ({
    start: intVal(xml.kid(lvl, 'start')) ?? 1,
    numFmt: xml.val(xml.kid(lvl, 'numFmt')) ?? 'decimal',
    lvlText: xml.val(xml.kid(lvl, 'lvlText')) ?? '',
    isLgl: xml.toggle(xml.kid(lvl, 'isLgl')) === true,
    hasRestartRule: !!xml.kid(lvl, 'lvlRestart'),
    pStyle: xml.val(xml.kid(lvl, 'pStyle'))
  });

  const abstracts = new Map();
  for (const abstract of xml.all(numberingDoc, 'abstractNum')) {
    const id = xml.attr(abstract, 'abstractNumId');
    if (id === undefined) continue;
    const levels = new Map();
    for (const lvl of xml.kids(abstract, 'lvl')) {
      const ilvl = Number(xml.attr(lvl, 'ilvl'));
      if (Number.isFinite(ilvl)) levels.set(ilvl, readLevel(lvl));
    }
    // Levels whose numbering restarts by a custom rule are not implemented; a level that
    // refers to one in its text would show a wrong number as well.
    const unsupported = new Set(
      [...levels].filter(([, level]) => level.hasRestartRule).map(([ilvl]) => ilvl)
    );
    let grew = unsupported.size > 0;
    while (grew) {
      grew = false;
      for (const [ilvl, level] of levels) {
        if (unsupported.has(ilvl)) continue;
        const referenced = Array.from(
          level.lvlText.matchAll(/%([1-9])/g),
          match => Number(match[1]) - 1
        );
        if (referenced.some(k => unsupported.has(k))) {
          unsupported.add(ilvl);
          grew = true;
        }
      }
    }
    const levelOfStyle = new Map();
    for (const [ilvl, level] of levels) if (level.pStyle) levelOfStyle.set(level.pStyle, ilvl);
    abstracts.set(id, {
      levels,
      unsupported,
      levelOfStyle,
      numStyleLink: xml.val(xml.kid(abstract, 'numStyleLink'))
    });
  }

  const nums = new Map();
  for (const num of xml.all(numberingDoc, 'num')) {
    const id = xml.attr(num, 'numId');
    if (id === undefined) continue;
    const overrides = new Map();
    for (const override of xml.kids(num, 'lvlOverride')) {
      const ilvl = Number(xml.attr(override, 'ilvl'));
      if (!Number.isFinite(ilvl)) continue;
      const lvl = xml.kid(override, 'lvl');
      overrides.set(ilvl, {
        startOverride: intVal(xml.kid(override, 'startOverride')),
        level: lvl ? readLevel(lvl) : undefined
      });
    }
    nums.set(id, { abstractId: xml.val(xml.kid(num, 'abstractNumId')), overrides });
  }

  /** A list that is defined by a numbering style (`w:numStyleLink`) uses that style's list. */
  const resolveAbstractId = (abstractId, depth = 0) => {
    const abstract = abstracts.get(abstractId);
    if (!abstract || !abstract.numStyleLink || depth > MAX_STYLE_LINK_DEPTH) return abstractId;
    const linkedNumId = styles.resolve(abstract.numStyleLink, 'numId');
    const linkedAbstractId = nums.get(linkedNumId)?.abstractId;
    return linkedAbstractId === undefined || linkedAbstractId === abstractId
      ? abstractId
      : resolveAbstractId(linkedAbstractId, depth + 1);
  };

  // Counters per list definition: all `w:num` that share a definition continue each other.
  const state = new Map();
  const stateOf = abstractId => {
    if (!state.has(abstractId)) state.set(abstractId, { counters: [], seenLevels: new Set() });
    return state.get(abstractId);
  };

  /**
   * Count one numbered paragraph and return what to show for it. Call it for every paragraph
   * that is visible, in document order.
   *
   * @param {string} numId - Effective `w:numId` (never "0")
   * @param {number|undefined} ilvl - Explicit list level, or undefined to derive it
   * @param {string|undefined} styleId - The paragraph's style, for a level linked to a style
   * @returns {{kind: 'label', text: string} | {kind: 'bullet'} | {kind: 'none'} |
   *   {kind: 'unsupported'} | {kind: 'unknown'}}
   */
  const advance = (numId, ilvl, styleId) => {
    const num = nums.get(numId);
    if (!num) return { kind: 'unknown' };
    const abstractId = resolveAbstractId(num.abstractId);
    const abstract = abstracts.get(abstractId);
    if (!abstract) return { kind: 'unknown' };

    const level = ilvl ?? abstract.levelOfStyle.get(styleId) ?? 0;
    const levelOf = (num_, k) => num_.overrides.get(k)?.level ?? abstract.levels.get(k);
    const current = levelOf(num, level);
    if (!current) return { kind: 'unsupported' };

    const { counters, seenLevels } = stateOf(abstractId);
    const levelKey = `${numId}:${level}`;
    if (!seenLevels.has(levelKey)) {
      // A start override restarts its level the first time this list instance uses that level
      // (not when the instance is first used at another level).
      seenLevels.add(levelKey);
      const startOverride = num.overrides.get(level)?.startOverride;
      if (startOverride !== undefined) counters[level] = startOverride - 1;
    }
    // A skipped higher level shows its start value; a deeper level starts over.
    for (let k = 0; k < level; k += 1) {
      if (counters[k] === undefined) counters[k] = levelOf(num, k)?.start ?? 1;
    }
    counters[level] = counters[level] === undefined ? current.start : counters[level] + 1;
    for (let deeper = level + 1; deeper < counters.length; deeper += 1)
      counters[deeper] = undefined;

    if (abstract.unsupported.has(level)) return { kind: 'unsupported' };
    if (current.numFmt === 'bullet') {
      // A bullet list stays a list for mammoth only when every level above is a bullet as well.
      // Under a numbered level (whose paragraph becomes plain text) mammoth would nest it in an
      // empty list item (`- - text`): a plain `-` paragraph is the better text.
      const inBulletList = Array.from({ length: level }, (_, k) => k).every(
        k => levelOf(num, k)?.numFmt === 'bullet'
      );
      return inBulletList ? { kind: 'bullet' } : { kind: 'label', text: '-' };
    }
    if (current.numFmt === 'none') return { kind: 'none' };

    const text = current.lvlText.replace(/%([1-9])/g, (_, digit) => {
      const k = Number(digit) - 1;
      const shown = levelOf(num, k);
      const value = counters[k] ?? shown?.start ?? 1;
      // Legal numbering shows every level as an Arabic number: roman numerals, letters and
      // ordinals become plain decimals; a zero-padded number already is one.
      const format = current.isLgl && shown?.numFmt !== 'decimalZero' ? 'decimal' : shown?.numFmt;
      return formatNumber(value, format);
    });
    return text ? { kind: 'label', text } : { kind: 'none' };
  };

  return { advance };
}
