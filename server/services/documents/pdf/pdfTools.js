// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { createPdf, renderPagePreview } from './PdfService.js';
import { DocumentGenerationError } from '../renderService.js';
import { heldGeneratedFile, holdGeneratedFile } from '../generatedFiles.js';
import { assertSpecSize, parseStructured, toolFailure } from '../documentToolHelpers.js';
import { applyTemplateToPdfSpec, templateBundleFor } from '../templates/applyTemplate.js';
import { loadUploadedFileOriginal, PDF_FILE_MIME } from '../templateFiles.js';
import { fillPdfFormFields } from './fillForm.js';

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
    // The cover page and the {date} placeholders share one date, today by default.
    date: args.date || new Date().toISOString().slice(0, 10),
    subject: args.subject,
    keywords: args.keywords,
    showTitle: args.showTitle,
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
    if (params.templateFileId && params.fillFormFields) {
      return await runFillPdfForm(params);
    }
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
    const { spec, assets: templateAssets } = applyTemplateToPdfSpec(
      specFromToolArgs(params),
      bundle
    );
    let assets = templateAssets;
    let letterheadName = null;
    if (params.templateFileId) {
      // The uploaded PDF is the stationery the new document is printed on.
      const uploaded = await loadUploadedFileOriginal({
        fileId: params.templateFileId,
        mimeTypes: [PDF_FILE_MIME],
        user: params.user,
        chatId: params.chatId
      });
      letterheadName = uploaded.name;
      assets = { ...(templateAssets || {}), letterhead: uploaded.buffer };
    }
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
      ...(letterheadName ? { templateFile: letterheadName } : {}),
      message: `Created "${file.name}" (${pages} page${pages === 1 ? '' : 's'})${bundle ? ` in the "${bundle.template.id}" document template` : ''}${letterheadName ? ` on the letterhead of the uploaded "${letterheadName}"` : ''}. The user sees a download card for it in the chat — do not add a link. Its file_id for preview_pdf is ${file.id}.`
    };
  } catch (error) {
    return failure(error);
  }
}

/**
 * `create_pdf` with `templateFileId` and `fillFormFields`: fill the interactive
 * form fields of the uploaded PDF in place and hand the result to the chat.
 *
 * @param {Object} params
 * @returns {Promise<Object>}
 */
async function runFillPdfForm(params) {
  const values = parseStructured(
    params.fillFormFields,
    'fillFormFields',
    'an object of form field names and values'
  );
  const uploaded = await loadUploadedFileOriginal({
    fileId: params.templateFileId,
    mimeTypes: [PDF_FILE_MIME],
    user: params.user,
    chatId: params.chatId
  });
  const { buffer, filled, unknown, failed, fields } = await fillPdfFormFields(
    uploaded.buffer,
    values,
    { flatten: params.flattenForm === true }
  );
  const base = (uploaded.name || 'form').replace(/\.pdf$/i, '');
  const file = holdGeneratedFile({
    user: params.user,
    chatId: params.chatId,
    data: buffer,
    mimeType: 'application/pdf',
    name: params.filename || `${base}-filled`
  });
  const warnings = [];
  if (unknown.length) {
    warnings.push(
      `Unknown form fields were ignored: ${unknown.join(', ')}. Available fields: ${fields.map(f => f.name).join(', ')}.`
    );
  }
  for (const entry of failed)
    warnings.push(`Field "${entry.name}" was not filled: ${entry.reason}.`);
  return {
    success: true,
    file,
    files: [file],
    filledFields: filled,
    templateFile: uploaded.name,
    ...(warnings.length ? { warnings } : {}),
    message: `Filled ${filled.length} form field${filled.length === 1 ? '' : 's'} of "${uploaded.name}" and saved it as "${file.name}". The user sees a download card for it in the chat — do not add a link.`
  };
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
