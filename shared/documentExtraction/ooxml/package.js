/**
 * Reading an Office Open XML package (docx, pptx, xlsx, …): the relationships that name the
 * parts of a document.
 *
 * @module shared/documentExtraction/ooxml/package
 */
import { parseXml } from './xml.js';

/** Resolve a relationship target against the directory of the part that owns the .rels file. */
export function resolveTarget(baseDir, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = baseDir ? baseDir.split('/') : [];
  for (const segment of target.split('/')) {
    if (segment === '..') parts.pop();
    else if (segment && segment !== '.') parts.push(segment);
  }
  return parts.join('/');
}

/** The parsed relationships of `ownerPart` (external ones left out), targets resolved. */
export async function readRelationships(zip, DOMParserCtor, ownerPart) {
  const slash = ownerPart.lastIndexOf('/');
  const dir = slash >= 0 ? ownerPart.slice(0, slash) : '';
  const name = slash >= 0 ? ownerPart.slice(slash + 1) : ownerPart;
  const relsFile = zip.file(`${dir ? `${dir}/` : ''}_rels/${name}.rels`);
  if (!relsFile) return [];
  const relsDoc = parseXml(DOMParserCtor, await relsFile.async('string'));
  return Array.from(relsDoc.getElementsByTagNameNS('*', 'Relationship'))
    .filter(rel => rel.getAttribute('TargetMode') !== 'External')
    .map(rel => ({
      id: rel.getAttribute('Id') || '',
      type: rel.getAttribute('Type') || '',
      target: resolveTarget(dir, rel.getAttribute('Target') || '')
    }));
}

/** Targets of the relationships of `ownerPart` whose type ends with one of `typeSuffixes`. */
export async function relationshipTargets(zip, DOMParserCtor, ownerPart, typeSuffixes) {
  const found = {};
  for (const rel of await readRelationships(zip, DOMParserCtor, ownerPart)) {
    const suffix = typeSuffixes.find(s => rel.type.endsWith(s));
    if (suffix) found[suffix] = rel.target;
  }
  return found;
}
