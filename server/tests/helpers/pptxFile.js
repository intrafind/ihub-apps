/**
 * Minimal PowerPoint packages for the document extraction tests: slides from raw PresentationML,
 * listed in the order the presentation shows them. No binaries are committed.
 */
import JSZip from 'jszip';

export const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** A text shape; `ph` is the placeholder type (`title`, `body`, …). */
export const shape = (paragraphs, ph) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="S"/><p:cNvSpPr/><p:nvPr>${ph ? `<p:ph type="${ph}"/>` : ''}</p:nvPr></p:nvSpPr>` +
  `<p:txBody><a:bodyPr/>${paragraphs.map(t => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp>`;

export const slide = (shapes, attrs = '') =>
  `${XML}<p:sld ${NS} ${attrs}><p:cSld><p:spTree>${shapes.join('')}</p:spTree></p:cSld></p:sld>`;

/**
 * @param {string[]} slides - Slide XML in creation order (slide1.xml, slide2.xml, …)
 * @param {number[]} order - Indexes into `slides`, in the order the presentation shows them
 * @param {Object<number,string>} [notes] - Notes slide XML by slide index
 * @returns {Promise<Buffer>}
 */
export async function buildPptx(slides, order, notes = {}) {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`
  );
  zip.file(
    '_rels/.rels',
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`
  );
  zip.file(
    'ppt/presentation.xml',
    `${XML}<p:presentation ${NS}><p:sldIdLst>${order
      .map((index, n) => `<p:sldId id="${256 + n}" r:id="rIdS${index + 1}"/>`)
      .join('')}</p:sldIdLst></p:presentation>`
  );
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides
      .map(
        (_, i) =>
          `<Relationship Id="rIdS${i + 1}" Type="${REL}/slide" Target="slides/slide${i + 1}.xml"/>`
      )
      .join('')}</Relationships>`
  );
  slides.forEach((xml, i) => {
    zip.file(`ppt/slides/slide${i + 1}.xml`, xml);
    zip.file(
      `ppt/slides/_rels/slide${i + 1}.xml.rels`,
      `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
        notes[i]
          ? `<Relationship Id="rIdN" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide${i + 1}.xml"/>`
          : ''
      }</Relationships>`
    );
    if (notes[i]) zip.file(`ppt/notesSlides/notesSlide${i + 1}.xml`, notes[i]);
  });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Notes slide XML with one text body. */
export const notesSlide = paragraphs =>
  `${XML}<p:notes ${NS}><p:cSld><p:spTree>${shape(paragraphs, 'body')}</p:spTree></p:cSld></p:notes>`;
