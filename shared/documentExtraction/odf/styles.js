/**
 * Styles of an OpenDocument file: the named and automatic styles of content.xml and styles.xml,
 * looked up through their `style:parent-style-name` chain.
 *
 * @module shared/documentExtraction/odf/styles
 */
import { NS, all, attr, attrOrEmpty, is, kid, kids } from './xml.js';

const MAX_CHAIN = 16; // a parent chain this long is a cycle or a hostile file

/**
 * @param {Document|null} contentDoc - content.xml
 * @param {Document|null} stylesDoc - styles.xml
 */
export function readStyles(contentDoc, stylesDoc) {
  const byKey = new Map();
  for (const doc of [stylesDoc, contentDoc]) {
    for (const style of all(doc, 'style', 'style')) {
      const name = attr(style, 'style', 'name');
      const family = attr(style, 'style', 'family');
      if (name && family) byKey.set(`${family}:${name}`, style);
    }
  }

  /** The style and its ancestors, nearest first. */
  const chain = (name, family) => {
    const result = [];
    let current = name ? byKey.get(`${family}:${name}`) : null;
    while (current && result.length < MAX_CHAIN) {
      result.push(current);
      const parent = attr(current, 'style', 'parent-style-name');
      current = parent ? byKey.get(`${family}:${parent}`) : null;
    }
    return result;
  };

  /**
   * The first value `read(styleElement)` returns for the style or one of its ancestors.
   *
   * @param {string|undefined} name
   * @param {string} family - `paragraph`, `text`, `table`, `drawing-page`, …
   * @param {(style: Element) => *} read - undefined means "not set here"
   */
  const resolve = (name, family, read) => {
    for (const style of chain(name, family)) {
      const value = read(style);
      if (value !== undefined) return value;
    }
    return undefined;
  };

  /** A property attribute of `style:<group>-properties` (e.g. `paragraph`, `text`, `table`). */
  const property = (name, family, group, ns, attribute) =>
    resolve(name, family, style => attr(kid(style, 'style', `${group}-properties`), ns, attribute));

  return {
    resolve,
    property,
    /** The page style change or break before a paragraph: it starts a new page. */
    breakBefore: name => property(name, 'paragraph', 'paragraph', 'fo', 'break-before') === 'page',
    breakAfter: name => property(name, 'paragraph', 'paragraph', 'fo', 'break-after') === 'page',
    /** Text the author hid (`text:display="none"`), as a paragraph or a character style. */
    hidden: (name, family) => property(name, family, 'text', 'text', 'display') === 'none',
    /** The list style a paragraph style is bound to; '' means explicitly none. */
    listStyleName: name =>
      resolve(name, 'paragraph', style => attrOrEmpty(style, 'style', 'list-style-name')),
    /** A table (sheet) the author hid. */
    tableHidden: name => property(name, 'table', 'table', 'table', 'display') === 'false',
    /** A slide hidden from the slide show. */
    slideHidden: name =>
      property(name, 'drawing-page', 'drawing-page', 'presentation', 'visibility') === 'hidden'
  };
}

export { NS, is, kids };
