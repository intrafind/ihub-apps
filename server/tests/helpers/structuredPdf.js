/**
 * PDF fixtures for the document extraction tests, built with pdf-lib (no binaries committed):
 * tagged PDFs with a structure tree (headings, tables), outlines, sized and fixed-width text.
 */
import {
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFOperator,
  PDFOperatorNames,
  StandardFonts,
  endMarkedContent
} from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * A page is a list of blocks:
 *  - `{ text, role?, size?, font? }` — one line; `role` (H1, P, …) tags it when the PDF is tagged
 *  - `{ table: [[cell, …], …], header? }` — rows of cells (`null` = empty cell); the first row
 *    is tagged TH when `header` is set
 *
 * @param {Array<Array<object>>} pages
 * @param {{tagged?: boolean, outline?: Array}} [options] - `outline`: `[{ title, page, items }]`
 */
export async function buildPdfBytes(pages, { tagged = true, outline = null } = {}) {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const fonts = {
    sans: await doc.embedFont(StandardFonts.Helvetica),
    mono: await doc.embedFont(StandardFonts.Courier)
  };
  const pageObjects = pages.map(() => doc.addPage([595, 842]));
  const topElements = [];
  const docElementRef = ctx.nextRef();
  const treeRootRef = ctx.nextRef();
  const parentTreeEntries = [];

  pages.forEach((blocks, pageIndex) => {
    const page = pageObjects[pageIndex];
    const owners = []; // struct element ref per MCID of this page
    let y = 790;
    const drawLeaf = (text, { x, size = 11, font = 'sans', role = 'P' }) => {
      const mcid = owners.length;
      if (tagged) {
        page.pushOperators(
          PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [
            PDFName.of(role),
            ctx.obj({ MCID: mcid })
          ])
        );
      }
      page.drawText(text, { x, y, size, font: fonts[font] });
      if (tagged) page.pushOperators(endMarkedContent());
      return mcid;
    };
    const element = (role, parentRef, extra) => {
      const ref = ctx.nextRef();
      ctx.assign(
        ref,
        ctx.obj({ Type: 'StructElem', S: role, P: parentRef, Pg: page.ref, ...extra })
      );
      return ref;
    };

    for (const block of blocks) {
      if (block.table) {
        const tableRef = ctx.nextRef();
        const rowRefs = [];
        let rowY = y;
        block.table.forEach((row, rowIndex) => {
          const rowRef = ctx.nextRef();
          const cellRefs = row.map((cell, column) => {
            const role = block.header && rowIndex === 0 ? 'TH' : 'TD';
            y = rowY;
            if (cell === null) return element(role, rowRef, {});
            const mcid = drawLeaf(cell, { x: 50 + column * 140, role: 'P' });
            const cellRef = element(role, rowRef, { K: mcid });
            owners[mcid] = cellRef;
            return cellRef;
          });
          ctx.assign(
            rowRef,
            ctx.obj({ Type: 'StructElem', S: 'TR', P: tableRef, Pg: page.ref, K: cellRefs })
          );
          rowRefs.push(rowRef);
          rowY -= 20;
        });
        ctx.assign(
          tableRef,
          ctx.obj({
            Type: 'StructElem',
            S: 'Table',
            P: docElementRef,
            Pg: page.ref,
            K: rowRefs
          })
        );
        topElements.push(tableRef);
        y = rowY - 10;
      } else {
        const size = block.size || 11;
        const mcid = drawLeaf(block.text, { x: 50, ...block, size });
        const ref = element(block.role || 'P', docElementRef, { K: mcid });
        owners[mcid] = ref;
        topElements.push(ref);
        y -= size * 1.6 + 4;
      }
    }
    page.node.set(PDFName.of('StructParents'), ctx.obj(pageIndex));
    parentTreeEntries.push(pageIndex, owners);
  });

  if (tagged) {
    ctx.assign(
      docElementRef,
      ctx.obj({ Type: 'StructElem', S: 'Document', P: treeRootRef, K: topElements })
    );
    const parentTreeRef = ctx.nextRef();
    ctx.assign(parentTreeRef, ctx.obj({ Nums: parentTreeEntries }));
    ctx.assign(
      treeRootRef,
      ctx.obj({ Type: 'StructTreeRoot', K: [docElementRef], ParentTree: parentTreeRef })
    );
    doc.catalog.set(PDFName.of('StructTreeRoot'), treeRootRef);
    doc.catalog.set(PDFName.of('MarkInfo'), ctx.obj({ Marked: true }));
  }

  if (outline) {
    const outlinesRef = ctx.nextRef();
    const build = (entries, parentRef) => {
      const refs = entries.map(() => ctx.nextRef());
      entries.forEach((entry, i) => {
        const dict = {
          Title: PDFHexString.fromText(entry.title),
          Parent: parentRef,
          Dest: [pageObjects[entry.page].ref, PDFName.of('XYZ'), null, 800, null]
        };
        if (i > 0) dict.Prev = refs[i - 1];
        if (i < entries.length - 1) dict.Next = refs[i + 1];
        if (entry.items && entry.items.length > 0) {
          const children = build(entry.items, refs[i]);
          dict.First = children[0];
          dict.Last = children[children.length - 1];
          dict.Count = entry.items.length;
        }
        ctx.assign(refs[i], ctx.obj(dict));
      });
      return refs;
    };
    const top = build(outline, outlinesRef);
    ctx.assign(
      outlinesRef,
      ctx.obj({ Type: 'Outlines', First: top[0], Last: top[top.length - 1], Count: top.length })
    );
    doc.catalog.set(PDFName.of('Outlines'), outlinesRef);
  }

  return doc.save();
}

/** The same PDF, opened with pdf.js. */
export async function buildPdf(pages, options) {
  return pdfjs.getDocument({ data: await buildPdfBytes(pages, options), verbosity: 0 }).promise;
}
