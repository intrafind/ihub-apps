/**
 * Paragraph/character style model of a Word document (styles.xml).
 *
 * Resolves the properties extraction needs through the `basedOn` chain, cycle-safe.
 *
 * @module shared/documentExtraction/ooxml/styles
 */

/**
 * @param {Document|null} stylesDoc - Parsed word/styles.xml, or null when the part is missing
 * @param {ReturnType<import('./xml.js').createWordXml>} xml
 */
export function readStyles(stylesDoc, xml) {
  const byId = new Map();
  for (const style of xml.all(stylesDoc, 'style')) {
    const id = xml.attr(style, 'styleId');
    if (!id) continue;
    const ppr = xml.kid(style, 'pPr');
    const rpr = xml.kid(style, 'rPr');
    const numPr = xml.kid(ppr, 'numPr');
    const outline = xml.val(xml.kid(ppr, 'outlineLvl'));
    byId.set(id, {
      type: xml.attr(style, 'type'),
      name: xml.val(xml.kid(style, 'name')),
      basedOn: xml.val(xml.kid(style, 'basedOn')),
      numId: xml.val(xml.kid(numPr, 'numId')),
      ilvl: xml.val(xml.kid(numPr, 'ilvl')),
      outlineLvl:
        outline === undefined || Number.isNaN(Number(outline)) ? undefined : Number(outline),
      pageBreakBefore: xml.toggle(xml.kid(ppr, 'pageBreakBefore')),
      vanish: xml.toggle(xml.kid(rpr, 'vanish'))
    });
  }

  /** First defined value of `prop` along the style and its `basedOn` ancestors. */
  const resolve = (styleId, prop) => {
    const seen = new Set();
    let current = styleId;
    while (current && !seen.has(current)) {
      seen.add(current);
      const style = byId.get(current);
      if (!style) return undefined;
      if (style[prop] !== undefined) return style[prop];
      current = style.basedOn;
    }
    return undefined;
  };

  return {
    has: id => byId.has(id),
    /** The style's own name (`heading 1`, `IF Kapitel`, …), not inherited. */
    name: id => byId.get(id)?.name,
    resolve
  };
}
