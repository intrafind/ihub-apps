// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import logger from '../../../utils/logger.js';
import {
  assertSpecSize,
  optionalString,
  parseStructured,
  toolFailure
} from '../documentToolHelpers.js';
import { holdGeneratedFile } from '../generatedFiles.js';
import { DocumentGenerationError, renderInWorker } from '../renderService.js';
import { applyTemplateToXlsxSpec, templateBundleFor } from '../templates/applyTemplate.js';
import { loadUploadedFileOriginal, XLSX_FILE_MIME } from '../templateFiles.js';

/**
 * The tool the `xlsx` system skill brings (see `server/systemSkills/xlsx`):
 * `create_xlsx` builds a formatted Excel workbook in the company's corporate
 * design and hands it to the chat as a generated file.
 */

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Turn `create_xlsx` arguments into a workbook spec.
 *
 * @param {Object} args
 * @returns {Object}
 */
export function xlsxSpecFromToolArgs(args) {
  const sheets = parseStructured(args.sheets, 'sheets', 'a JSON array of worksheets');
  if (!Array.isArray(sheets) || sheets.length === 0) {
    throw new DocumentGenerationError(
      '"sheets" must be a non-empty JSON array of worksheets.',
      'invalid'
    );
  }
  const spec = {
    title: optionalString(args.title, 300),
    author: optionalString(args.author, 200),
    language: optionalString(args.language, 20),
    sheets,
    brand: {
      primaryColor: optionalString(args.primaryColor, 20),
      accentColor: optionalString(args.accentColor, 20),
      font: optionalString(args.font, 80)
    }
  };
  assertSpecSize(spec);
  return spec;
}

/**
 * Render an Excel workbook spec in the render worker, with the corporate
 * document template applied.
 *
 * @param {Object} spec
 * @param {Object} [options]
 * @param {Object} [options.app]
 * @param {string} [options.template] - Requested template id.
 * @returns {Promise<{ buffer: Buffer, sheets: number, warnings: string[], templateId: string|null }>}
 */
export async function createXlsx(spec, { app, template, sourceFile = null } = {}) {
  const bundle = await templateBundleFor({ format: 'xlsx', app, requested: template });
  const applied = applyTemplateToXlsxSpec(spec, bundle);
  if (sourceFile?.buffer) {
    applied.assets = { sourceWorkbook: sourceFile.buffer };
  }
  const started = Date.now();
  const { buffer, meta, warnings } = await renderInWorker('xlsx', {
    spec: applied.spec,
    assets: applied.assets
  });
  logger.info('Spreadsheet generated', {
    component: 'XlsxService',
    sheets: meta.sheets,
    bytes: buffer.length,
    template: applied.templateId,
    durationMs: Date.now() - started
  });
  return {
    buffer,
    sheets: meta.sheets,
    added: meta.added || [],
    replaced: meta.replaced || [],
    warnings,
    templateId: applied.templateId
  };
}

/**
 * `create_xlsx`: build the Excel workbook and hand it to the chat.
 *
 * @param {Object} params - Tool arguments plus the trusted context (`user`,
 *   `chatId`, `appConfig`).
 * @returns {Promise<Object>}
 */
export async function runCreateXlsx(params) {
  try {
    const spec = xlsxSpecFromToolArgs(params);
    let sourceFile = null;
    if (params.sourceFileId) {
      const uploaded = await loadUploadedFileOriginal({
        fileId: params.sourceFileId,
        mimeTypes: [XLSX_FILE_MIME],
        user: params.user,
        chatId: params.chatId,
        parameter: 'sourceFileId'
      });
      sourceFile = { buffer: uploaded.buffer, name: uploaded.name };
    }
    const { buffer, sheets, added, replaced, warnings, templateId } = await createXlsx(spec, {
      app: params.appConfig,
      template: params.template,
      sourceFile
    });
    const file = holdGeneratedFile({
      user: params.user,
      chatId: params.chatId,
      data: buffer,
      mimeType: XLSX_MIME,
      name: params.filename || params.title,
      meta: { sheets }
    });
    return {
      success: true,
      file,
      files: [file],
      ...(templateId ? { template: templateId } : {}),
      ...(sourceFile
        ? { sourceFile: sourceFile.name, addedSheets: added, replacedSheets: replaced }
        : {}),
      ...(warnings.length ? { warnings } : {}),
      message: `${sourceFile ? `Updated the uploaded workbook "${sourceFile.name}" (added: ${added.join(', ') || 'none'}; replaced: ${replaced.join(', ') || 'none'}) and saved it as` : 'Created the Excel workbook'} "${file.name}" (${sheets} sheet${sheets === 1 ? '' : 's'})${templateId ? ` on the "${templateId}" document template` : ''}. The user sees a download card for it in the chat — do not add a link.`
    };
  } catch (error) {
    return toolFailure(error, 'The Excel workbook could not be created.');
  }
}
