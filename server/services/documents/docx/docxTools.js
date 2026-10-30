// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import logger from '../../../utils/logger.js';
import { assertSpecSize, optionalString, toolFailure } from '../documentToolHelpers.js';
import { holdGeneratedFile } from '../generatedFiles.js';
import { DocumentGenerationError, renderInWorker } from '../renderService.js';
import { applyTemplateToDocxSpec, templateBundleFor } from '../templates/applyTemplate.js';

/**
 * The tool the `docx` system skill brings (see `server/systemSkills/docx`):
 * `create_docx` renders a Word document from Markdown, in the app's document
 * template, and hands it to the chat as a generated file.
 */

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Turn `create_docx` arguments into a document spec.
 *
 * @param {Object} args
 * @returns {import('./buildDocx.js').DocxSpec}
 */
export function docxSpecFromToolArgs(args) {
  const spec = {
    title: optionalString(args.title, 300),
    subtitle: optionalString(args.subtitle, 300),
    author: optionalString(args.author, 200),
    language: optionalString(args.language, 20),
    markdown: typeof args.markdown === 'string' ? args.markdown : '',
    coverPage: args.coverPage === true,
    toc: args.toc === true,
    header: optionalString(args.header, 300),
    footer: optionalString(args.footer, 300),
    pageNumbers: args.pageNumbers !== false,
    page: { size: args.pageSize, orientation: args.orientation },
    colors: { primary: optionalString(args.primaryColor, 20) },
    fonts: { body: optionalString(args.font, 64) }
  };
  assertSpecSize(spec);
  return spec;
}

/**
 * Render a Word document spec in the render worker, with the template applied.
 *
 * @param {Object} spec
 * @param {Object} [options]
 * @param {Object} [options.app]
 * @param {string} [options.template] - Requested template id.
 * @returns {Promise<{ buffer: Buffer, warnings: string[], templateId: string|null }>}
 */
export async function createDocx(spec, { app, template } = {}) {
  const bundle = await templateBundleFor({ format: 'docx', app, requested: template });
  const applied = applyTemplateToDocxSpec(spec, bundle);
  const started = Date.now();
  const { buffer, warnings } = await renderInWorker('docx', {
    spec: applied.spec,
    assets: applied.assets
  });
  logger.info('Word document generated', {
    component: 'DocxService',
    bytes: buffer.length,
    template: applied.templateId,
    durationMs: Date.now() - started
  });
  return { buffer, warnings, templateId: applied.templateId };
}

/**
 * `create_docx`: render the document and hand it to the chat.
 *
 * @param {Object} params - Tool arguments plus the trusted context (`user`,
 *   `chatId`, `appConfig`).
 * @returns {Promise<Object>}
 */
export async function runCreateDocx(params) {
  try {
    if (typeof params.markdown !== 'string' || !params.markdown.trim()) {
      throw new DocumentGenerationError('Provide the document content in "markdown".', 'invalid');
    }
    const spec = docxSpecFromToolArgs(params);
    const { buffer, warnings, templateId } = await createDocx(spec, {
      app: params.appConfig,
      template: params.template
    });
    const file = holdGeneratedFile({
      user: params.user,
      chatId: params.chatId,
      data: buffer,
      mimeType: DOCX_MIME,
      name: params.filename || params.title
    });
    return {
      success: true,
      file,
      // Picked up by the chat tool seam, which streams the bytes to the
      // chat's download card. The result itself never carries them.
      files: [file],
      ...(templateId ? { template: templateId } : {}),
      ...(warnings.length ? { warnings } : {}),
      message: `Created the Word document "${file.name}"${templateId ? ` in the "${templateId}" document template` : ''}. The user sees a download card for it in the chat — do not add a link.`
    };
  } catch (error) {
    return toolFailure(error, 'The Word document could not be created.');
  }
}
