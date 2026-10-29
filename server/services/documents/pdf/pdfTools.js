// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { createPdf, renderPagePreview } from './PdfService.js';
import { DocumentGenerationError } from '../renderService.js';
import { heldGeneratedFile, holdGeneratedFile } from '../generatedFiles.js';
import { assertSpecSize, parseStructured, toolFailure } from '../documentToolHelpers.js';
import { applyTemplateToPdfSpec, templateBundleFor } from '../templates/applyTemplate.js';

/**
 * The tools the `pdf` system skill brings (see `server/systemSkills/pdf`).
 *
 * `create_pdf` renders a document from Markdown and/or layout blocks and
 * hands it to the chat as a generated file (see `../generatedFiles.js`);
 * `preview_pdf` shows the model one page of a PDF it created, so it can check
 * the layout.
 */

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
  assertSpecSize(spec);
  return spec;
}

function failure(error) {
  return toolFailure(error, 'The PDF could not be created.');
}

/**
 * `create_pdf`: render the document and hand it to the chat.
 *
 * @param {Object} params - Tool arguments plus the trusted context (`user`, `chatId`, …).
 * @returns {Promise<Object>}
 */
export async function runCreatePdf(params) {
  try {
    if (!params.markdown && !params.blocks) {
      throw new DocumentGenerationError(
        'Provide the document content in "markdown" and/or "blocks".',
        'invalid'
      );
    }
    const bundle = await templateBundleFor({
      format: 'pdf',
      app: params.appConfig,
      requested: params.template
    });
    const { spec, assets } = applyTemplateToPdfSpec(specFromToolArgs(params), bundle);
    const { buffer, pages, warnings } = await createPdf(spec, { assets });
    const file = holdGeneratedFile({
      user: params.user,
      chatId: params.chatId,
      data: buffer,
      mimeType: 'application/pdf',
      name: params.filename || params.title,
      meta: { pages }
    });
    return {
      success: true,
      file,
      // Picked up by the chat tool seam, which streams the bytes to the chat's
      // download card. The result itself never carries them.
      files: [file],
      ...(warnings.length ? { warnings } : {}),
      ...(bundle ? { template: bundle.template.id } : {}),
      message: `Created "${file.name}" (${pages} page${pages === 1 ? '' : 's'})${bundle ? ` in the "${bundle.template.id}" document template` : ''}. The user sees a download card for it in the chat — do not add a link. Its file_id for preview_pdf is ${file.id}.`
    };
  } catch (error) {
    return failure(error);
  }
}

/**
 * `preview_pdf`: one page of a PDF `create_pdf` made in this chat, as an
 * image for the model (the image-lift seam turns `imageData` into a vision
 * message).
 *
 * @param {Object} params
 * @returns {Promise<Object>}
 */
export async function runPreviewPdf(params) {
  try {
    const file = heldGeneratedFile(params.user, String(params.file_id || ''), {
      chatId: params.chatId
    });
    if (!file || file.mimeType !== 'application/pdf') {
      return {
        success: false,
        error: `No PDF with id "${params.file_id}" is available. Only PDFs created in this chat within the last hour can be previewed; create it again to preview it.`
      };
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
