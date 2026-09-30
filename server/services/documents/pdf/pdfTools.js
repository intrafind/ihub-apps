import { createPdf, PdfGenerationError, renderPagePreview } from './PdfService.js';
import {
  describeGeneratedFile,
  GeneratedFileError,
  getGeneratedFile,
  saveGeneratedFile
} from '../generatedFiles.js';

/**
 * The tools the `pdf` system skill brings (see `server/systemSkills/pdf`).
 *
 * `create_pdf` renders a document from Markdown and/or layout blocks and
 * stores it as a generated file the user can download; `preview_pdf` shows
 * the model one page of a PDF it created, so it can check the layout.
 */

const MAX_SPEC_CHARS = 4 * 1024 * 1024;

/**
 * A structured argument, given as a value or as its JSON (some providers'
 * schemas cannot declare free-form objects).
 */
function parseStructured(value, name, what) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      throw new PdfGenerationError(`"${name}" must be ${what} (or its JSON).`, 'invalid');
    }
  }
  return value;
}

/**
 * Turn `create_pdf` arguments into a document spec.
 *
 * @param {Object} args
 * @returns {import('./buildDocument.js').PdfSpec}
 */
export function specFromToolArgs(args) {
  const blocks = parseStructured(args.blocks, 'blocks', 'an array of layout blocks');
  const spec = {
    title: args.title,
    subtitle: args.subtitle,
    author: args.author,
    language: args.language,
    markdown: args.markdown,
    blocks,
    styles: parseStructured(args.styles, 'styles', 'an object of named styles'),
    images: parseStructured(args.images, 'images', 'an object of named data: images'),
    theme: args.theme,
    themeOptions: {
      primaryColor: args.primaryColor,
      accentColor: args.accentColor,
      font: args.font,
      fontSize: args.fontSize
    },
    page: { size: args.pageSize, orientation: args.orientation, margins: args.margins },
    header: args.header || undefined,
    footer: args.footer || undefined,
    pageNumbers: args.pageNumbers,
    coverPage: args.coverPage,
    toc: args.toc,
    watermark: args.watermark || undefined
  };
  if (JSON.stringify(spec).length > MAX_SPEC_CHARS) {
    throw new PdfGenerationError('The document is too large (over 4 MB of content).', 'invalid');
  }
  return spec;
}

function failure(error) {
  const known = error instanceof PdfGenerationError || error instanceof GeneratedFileError;
  return {
    success: false,
    error: known ? error.message : 'The PDF could not be created.',
    ...(known && error.code ? { code: error.code } : {})
  };
}

/**
 * `create_pdf`: render the document and store it for the user.
 *
 * @param {Object} params - Tool arguments plus the trusted context (`user`, `chatId`, …).
 * @returns {Promise<Object>}
 */
export async function runCreatePdf(params) {
  const { user } = params;
  try {
    if (!params.markdown && !params.blocks) {
      throw new PdfGenerationError(
        'Provide the document content in "markdown" and/or "blocks".',
        'invalid'
      );
    }
    const spec = specFromToolArgs(params);
    const { buffer, pages, warnings } = await createPdf(spec);
    const saved = await saveGeneratedFile({
      user,
      data: buffer,
      mimeType: 'application/pdf',
      name: params.filename || params.title,
      meta: { pages }
    });
    const file = describeGeneratedFile(saved);
    return {
      success: true,
      file,
      // Picked up by the chat tool seam: the chat shows a download card.
      files: [file],
      ...(warnings.length ? { warnings } : {}),
      message: `Created "${file.name}" (${pages} page${pages === 1 ? '' : 's'}). The user sees a download card for it in the chat — do not add a link. Its file_id for preview_pdf is ${file.id}.`
    };
  } catch (error) {
    return failure(error);
  }
}

/**
 * `preview_pdf`: one page of the user's generated PDF as an image for the
 * model (the image-lift seam turns `imageData` into a vision message).
 *
 * @param {Object} params
 * @returns {Promise<Object>}
 */
export async function runPreviewPdf(params) {
  try {
    const file = await getGeneratedFile(params.user, String(params.file_id || ''));
    if (!file || file.mimeType !== 'application/pdf') {
      return { success: false, error: `No PDF with id "${params.file_id}" was found.` };
    }
    const preview = await renderPagePreview(file.data, Number(params.page) || 1);
    return {
      success: true,
      page: preview.page,
      pages: preview.pages,
      imageData: {
        type: 'image',
        base64: preview.png.toString('base64'),
        format: 'image/png',
        filename: `${file.name || 'document.pdf'} — page ${preview.page} of ${preview.pages}`
      }
    };
  } catch (error) {
    return failure(error);
  }
}
