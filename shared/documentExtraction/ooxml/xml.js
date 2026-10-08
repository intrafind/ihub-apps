/**
 * Namespace-aware helpers for WordprocessingML documents.
 *
 * Works on any W3C DOM `Document` (browser DOMParser, jsdom), so the logic stays
 * dependency-free. Transitional and Strict OOXML differ only in the namespace.
 *
 * @module shared/documentExtraction/ooxml/xml
 */

export const W_NS_TRANSITIONAL = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
// An XML namespace name, not an address that is ever requested.
export const W_NS_STRICT = 'http://purl.oclc.org/ooxml/wordprocessingml/main'; // NOSONAR

/**
 * Parse XML text; throws for malformed XML (the caller falls back to legacy extraction).
 *
 * @param {typeof DOMParser} DOMParserCtor
 * @param {string} text
 * @returns {Document}
 */
export function parseXml(DOMParserCtor, text) {
  const doc = new DOMParserCtor().parseFromString(text, 'application/xml');
  if (!doc || !doc.documentElement || doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('Malformed XML part');
  }
  return doc;
}

/** The WordprocessingML namespace a document uses (Transitional unless its root says Strict). */
export function wordNamespaceOf(doc) {
  return doc?.documentElement?.namespaceURI === W_NS_STRICT ? W_NS_STRICT : W_NS_TRANSITIONAL;
}

/**
 * Accessors bound to one WordprocessingML namespace.
 *
 * @param {string} ns
 */
export function createWordXml(ns) {
  const isW = (node, name) => !!node && node.namespaceURI === ns && node.localName === name;
  const kids = (el, name) => (el ? Array.from(el.childNodes).filter(node => isW(node, name)) : []);
  const kid = (el, name) => kids(el, name)[0] || null;
  const attr = (el, name) => {
    if (!el) return undefined;
    const value = el.getAttributeNS(ns, name);
    if (value !== null && value !== '') return value;
    const prefixed = el.getAttribute(`w:${name}`);
    return prefixed === null ? undefined : prefixed;
  };
  return {
    ns,
    isW,
    kids,
    kid,
    attr,
    /** `w:val` of an element, or undefined. */
    val: el => attr(el, 'val'),
    /** All descendants with the given local name, in document order (live list copied). */
    all: (root, name) => (root ? Array.from(root.getElementsByTagNameNS(ns, name)) : []),
    /** A new element in the Word namespace with the `w:` prefix. */
    create: (doc, name) => doc.createElementNS(ns, `w:${name}`),
    /**
     * OOXML on/off property (`w:vanish`, `w:pageBreakBefore`, …): present without a value
     * or with 1/true/on → true; 0/false/off → false; element absent → undefined.
     */
    toggle: el => {
      if (!el) return undefined;
      const value = attr(el, 'val');
      if (value === undefined) return true;
      return !['0', 'false', 'off'].includes(String(value).toLowerCase());
    }
  };
}
