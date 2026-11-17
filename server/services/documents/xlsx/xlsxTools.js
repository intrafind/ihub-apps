// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import logger from '../../../utils/logger.js';
import {
  assertSpecSize,
  optionalString,
  parseStructured,
  toolFailure
} from '../documentToolHelpers.js';
import {
  applySettings,
  applyTextEditsToStrings,
  editableSourceOf,
  editResultOf,
  embedSource,
  textEditsOf,
  toolArgsOf
} from '../editableSource.js';
import { GeneratedFileError, holdGeneratedFile } from '../generatedFiles.js';
import { DocumentGenerationError, renderInWorker } from '../renderService.js';
import { CREATE_XLSX_TOOL } from './xlsxToolDefinitions.js';
import { applySheetChanges } from './xlsxEdit.js';
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
      data: await embedSource(buffer, 'xlsx', {
        tool: CREATE_XLSX_TOOL.id,
        args: toolArgsOf(params, CREATE_XLSX_TOOL)
      }),
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

/** What `set` may change on a Excel workbook: every argument but its content and name. */
const SETTINGS = Object.keys(CREATE_XLSX_TOOL.parameters.properties).filter(
  key => !['sheets', 'filename'].includes(key)
);

/**
 * `edit_xlsx`: change a Excel workbook this chat made — operations on its stored
 * `sheets`, exact text replacements in its texts, new settings — and build it
 * again under the same name.
 *
 * @param {Object} params - `filename`, `changes`, `edits`, `set`, plus the trusted context.
 * @returns {Promise<Object>}
 */
export async function runEditXlsx(params) {
  try {
    const edits = textEditsOf(params.edits, {
      required: false,
      rewriteHint: 'use "changes" or create the workbook again with create_xlsx'
    });
    if (params.changes === undefined && !edits.length && params.set === undefined) {
      throw new GeneratedFileError(
        'Give "changes" (sheet operations), "edits" (text replacements), "set" (settings), or a combination.',
        'invalid'
      );
    }
    const { name, args } = await editableSourceOf(params, {
      tool: CREATE_XLSX_TOOL.id,
      extension: /\.xlsx$/i,
      what: 'Excel workbook'
    });
    const next = applySettings(args, params.set, SETTINGS);
    const current = parseStructured(args.sheets, 'sheets', 'a JSON array') || [];
    let sheets = applySheetChanges(current, params.changes);
    if (edits.length) {
      sheets = applyTextEditsToStrings(sheets, edits, {
        readHint: 'read the workbook with chat_artifacts_read, which returns its sheets as JSON'
      });
    }
    next.sheets = sheets;
    if (JSON.stringify(next) === JSON.stringify({ ...args, sheets: current })) {
      throw new GeneratedFileError('The changes change nothing.', 'invalid');
    }
    const result = await runCreateXlsx({
      ...next,
      filename: name,
      user: params.user,
      chatId: params.chatId,
      appConfig: params.appConfig
    });
    const parsedChanges = parseStructured(params.changes, 'changes', 'a list') || [];
    return editResultOf(result, parsedChanges.length + edits.length + (params.set ? 1 : 0));
  } catch (error) {
    return toolFailure(error, 'The Excel workbook could not be changed.');
  }
}
