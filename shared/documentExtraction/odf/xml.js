/**
 * Namespace-aware helpers for OpenDocument XML (content.xml, styles.xml).
 *
 * Everything is looked up by namespace and local name, never by prefix: producers are free to
 * choose their own prefixes.
 *
 * @module shared/documentExtraction/odf/xml
 */

export const NS = {
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  draw: 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
  presentation: 'urn:oasis:names:tc:opendocument:xmlns:presentation:1.0',
  fo: 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
  svg: 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0',
  xlink: 'http://www.w3.org/1999/xlink',
  xml: 'http://www.w3.org/XML/1998/namespace' // NOSONAR — a namespace name, never requested
};

/** Whether `node` is the element `ns:name`. */
export const is = (node, ns, name) =>
  !!node && node.nodeType === 1 && node.namespaceURI === NS[ns] && node.localName === name;

/** Element children, optionally only those named `ns:name`. */
export function kids(el, ns, name) {
  if (!el) return [];
  const result = [];
  for (let node = el.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 1 && (!ns || is(node, ns, name))) result.push(node);
  }
  return result;
}

export const kid = (el, ns, name) => kids(el, ns, name)[0] || null;

/** All descendants named `ns:name`, in document order. */
export const all = (root, ns, name) =>
  root ? Array.from(root.getElementsByTagNameNS(NS[ns], name)) : [];

/** Attribute `ns:name` of an element, or undefined. */
export function attr(el, ns, name) {
  if (!el) return undefined;
  const value = el.getAttributeNS(NS[ns], name);
  return value === null || value === '' ? undefined : value;
}

/**
 * Attribute that may legitimately be empty (`style:list-style-name=""` means "no list"):
 * undefined only when the attribute is absent.
 */
export function attrOrEmpty(el, ns, name) {
  if (!el || !el.hasAttributeNS(NS[ns], name)) return undefined;
  return el.getAttributeNS(NS[ns], name);
}
