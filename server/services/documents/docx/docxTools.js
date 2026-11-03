// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import logger from '../../../utils/logger.js';
import { assertSpecSize, optionalString, toolFailure } from '../documentToolHelpers.js';
import { holdGeneratedFile } from '../generatedFiles.js';
import { DocumentGenerationError, renderInWorker } from '../renderService.js';
import { applyTemplateToDocxSpec, templateBundleFor } from '../templates/applyTemplate.js';
import {
  DOCX_FILE_MIME,
  loadUploadedFileOriginal,
  userTemplateUploadsAllowed
} from '../templateFiles.js';
import { WORD_TEMPLATE_MODES } from './wordTemplate.js';

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
    date: optionalString(args.date, 100),
    showTitle: args.showTitle !== false,
    language: optionalString(args.language, 20),
    markdown: typeof args.markdown === 'string' ? args.markdown : '',
    coverPage: args.coverPage === true,
    toc: args.toc === true,
    header: optionalString(args.header, 300),
    footer: optionalString(args.footer, 300),
    pageNumbers: args.pageNumbers !== false,
    page: { size: args.pageSize, orientation: args.orientation },
    colors: {
      primary: optionalString(args.primaryColor, 20),
      accent: optionalString(args.accentColor, 20)
    },
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
export async function createDocx(spec, { app, template, templateFile = null } = {}) {
  const bundle = await templateBundleFor({ format: 'docx', app, requested: template });
  const applied = applyTemplateToDocxSpec(spec, bundle);
  if (templateFile?.buffer) {
    // The user's own document: its styles, headers/footers and page setup win
    // over the admin template; the content mode decides about its old body.
    applied.assets = { wordTemplate: templateFile.buffer };
    applied.spec = { ...applied.spec, templateMode: templateFile.mode || 'auto' };
    applied.templateId = null;
  }
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
    const extraWarnings = [];
    let templateFile = null;
    if (params.templateFileId) {
      if (params.templateMode && !WORD_TEMPLATE_MODES.includes(params.templateMode)) {
        throw new DocumentGenerationError(
          `"templateMode" must be one of: ${WORD_TEMPLATE_MODES.join(', ')}.`,
          'invalid'
        );
      }
      if (userTemplateUploadsAllowed(params.appConfig)) {
        const uploaded = await loadUploadedFileOriginal({
          fileId: params.templateFileId,
          mimeTypes: [DOCX_FILE_MIME],
          user: params.user,
          chatId: params.chatId
        });
        templateFile = {
          buffer: uploaded.buffer,
          mode: params.templateMode || 'auto',
          name: uploaded.name
        };
      } else {
        extraWarnings.push(
          'This app uses a fixed corporate document template, so the uploaded file was not used as a template.'
        );
      }
    }
    const {
      buffer,
      warnings: renderWarnings,
      templateId
    } = await createDocx(spec, {
      app: params.appConfig,
      template: params.template,
      templateFile
    });
    const warnings = [...extraWarnings, ...renderWarnings];
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
      ...(templateFile ? { templateFile: templateFile.name } : {}),
      ...(warnings.length ? { warnings } : {}),
      message: `Created the Word document "${file.name}"${templateId ? ` in the "${templateId}" document template` : ''}${templateFile ? ` using the styles of the uploaded "${templateFile.name}"` : ''}. The user sees a download card for it in the chat — do not add a link.`
    };
  } catch (error) {
    return toolFailure(error, 'The Word document could not be created.');
  }
}
