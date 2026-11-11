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
import { applyTemplateToPptxSpec, templateBundleFor } from '../templates/applyTemplate.js';
import {
  loadUploadedFileOriginal,
  PPTX_FILE_MIME,
  userTemplateUploadsAllowed
} from '../templateFiles.js';

export const PPTX_TEMPLATE_MODES = Object.freeze(['styles_only', 'append']);

/**
 * The tool the `pptx` system skill brings (see `server/systemSkills/pptx`):
 * `create_pptx` builds a presentation on the app's slide template and hands
 * it to the chat as a generated file.
 */

export const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/**
 * Turn `create_pptx` arguments into a presentation spec.
 *
 * @param {Object} args
 * @returns {Object}
 */
export function pptxSpecFromToolArgs(args) {
  const slides = parseStructured(args.slides, 'slides', 'a JSON array of slides');
  if (!Array.isArray(slides) || slides.length === 0) {
    throw new DocumentGenerationError(
      '"slides" must be a non-empty JSON array of slides.',
      'invalid'
    );
  }
  const spec = {
    title: optionalString(args.title, 300),
    author: optionalString(args.author, 200),
    language: optionalString(args.language, 20),
    slides,
    footer: optionalString(args.footer, 200),
    slideNumbers: args.slideNumbers !== false,
    brand: {
      primaryColor: optionalString(args.primaryColor, 20),
      aspectRatio: args.aspectRatio === '4:3' ? '4:3' : '16:9'
    }
  };
  assertSpecSize(spec);
  return spec;
}

/**
 * Render a presentation spec in the render worker, with the template applied.
 *
 * @param {Object} spec
 * @param {Object} [options]
 * @param {Object} [options.app]
 * @param {string} [options.template] - Requested template id.
 * @returns {Promise<{ buffer: Buffer, slides: number, warnings: string[], templateId: string|null }>}
 */
export async function createPptx(spec, { app, template, templateFile = null } = {}) {
  const bundle = await templateBundleFor({ format: 'pptx', app, requested: template });
  const applied = applyTemplateToPptxSpec(spec, bundle);
  if (templateFile?.buffer) {
    // The user's own deck: its master, layouts and theme build the slides. The
    // admin brand settings (colours, fonts, logo) only describe the built-in
    // template, so they are left out of the way.
    applied.assets = { powerpointTemplate: templateFile.buffer };
    applied.spec = {
      ...applied.spec,
      layouts: undefined,
      slotConfig: undefined,
      templateMode: templateFile.mode === 'append' ? 'append' : 'styles_only'
    };
    applied.templateId = null;
  }
  const started = Date.now();
  const { buffer, meta, warnings } = await renderInWorker('pptx', {
    spec: applied.spec,
    assets: applied.assets
  });
  logger.info('Presentation generated', {
    component: 'PptxService',
    slides: meta.slides,
    bytes: buffer.length,
    template: applied.templateId,
    durationMs: Date.now() - started
  });
  return { buffer, slides: meta.slides, warnings, templateId: applied.templateId };
}

/**
 * `restyle_pptx`: move a presentation the user uploaded onto the document
 * template's slide master and layouts and hand the result to the chat. The
 * deck's content is carried over, not rebuilt from text.
 *
 * @param {Object} params - Tool arguments plus the trusted context (`user`,
 *   `chatId`, `appConfig`).
 * @returns {Promise<Object>}
 */
export async function runRestylePptx(params) {
  try {
    const uploaded = await loadUploadedFileOriginal({
      fileId: params.fileId,
      mimeTypes: [PPTX_FILE_MIME],
      user: params.user,
      chatId: params.chatId,
      parameter: 'fileId'
    });
    const bundle = await templateBundleFor({
      format: 'pptx',
      app: params.appConfig,
      requested: params.template
    });
    const applied = applyTemplateToPptxSpec({ slides: [], brand: {} }, bundle);
    const started = Date.now();
    const { buffer, meta, warnings } = await renderInWorker('pptxRestyle', {
      spec: {
        brand: applied.spec.brand,
        layouts: applied.spec.layouts,
        slotConfig: applied.spec.slotConfig,
        footer: applied.spec.footer,
        slideNumbers: applied.spec.slideNumbers,
        title: uploaded.name.replace(/\.pptx$/i, ''),
        author: applied.spec.author
      },
      assets: {
        deck: uploaded.buffer,
        powerpointTemplate: applied.assets?.powerpointTemplate,
        logo: applied.assets?.logo
      }
    });
    logger.info('Presentation restyled', {
      component: 'PptxService',
      slides: meta.slides,
      bytes: buffer.length,
      template: applied.templateId,
      durationMs: Date.now() - started
    });
    const target = applied.templateId
      ? `onto the "${applied.templateId}" document template`
      : "onto iHub's built-in slide design";
    const file = holdGeneratedFile({
      user: params.user,
      chatId: params.chatId,
      data: buffer,
      mimeType: PPTX_MIME,
      name: params.filename || uploaded.name.replace(/\.pptx$/i, ''),
      meta: { slides: meta.slides }
    });
    return {
      success: true,
      file,
      files: [file],
      ...(applied.templateId ? { template: applied.templateId } : {}),
      ...(warnings.length ? { warnings } : {}),
      message: `Moved "${uploaded.name}" (${meta.slides} slide${meta.slides === 1 ? '' : 's'}) ${target} and created "${file.name}". Pictures, charts, tables and speaker notes were kept; slide backgrounds and the old master were dropped. The user sees a download card for it in the chat — do not add a link.`
    };
  } catch (error) {
    return toolFailure(error, 'The presentation could not be restyled.');
  }
}

/**
 * `create_pptx`: build the presentation and hand it to the chat.
 *
 * @param {Object} params - Tool arguments plus the trusted context (`user`,
 *   `chatId`, `appConfig`).
 * @returns {Promise<Object>}
 */
export async function runCreatePptx(params) {
  try {
    const spec = pptxSpecFromToolArgs(params);
    const extraWarnings = [];
    let templateFile = null;
    if (params.templateFileId) {
      if (params.templateMode && !PPTX_TEMPLATE_MODES.includes(params.templateMode)) {
        throw new DocumentGenerationError(
          `"templateMode" must be one of: ${PPTX_TEMPLATE_MODES.join(', ')}.`,
          'invalid'
        );
      }
      if (userTemplateUploadsAllowed(params.appConfig)) {
        const uploaded = await loadUploadedFileOriginal({
          fileId: params.templateFileId,
          mimeTypes: [PPTX_FILE_MIME],
          user: params.user,
          chatId: params.chatId
        });
        templateFile = {
          buffer: uploaded.buffer,
          mode: params.templateMode || 'styles_only',
          name: uploaded.name
        };
      } else {
        extraWarnings.push(
          'This app uses a fixed corporate document template, so the uploaded deck was not used as a template.'
        );
      }
    }
    const {
      buffer,
      slides,
      warnings: renderWarnings,
      templateId
    } = await createPptx(spec, {
      app: params.appConfig,
      template: params.template,
      templateFile
    });
    const warnings = [...extraWarnings, ...renderWarnings];
    const file = holdGeneratedFile({
      user: params.user,
      chatId: params.chatId,
      data: buffer,
      mimeType: PPTX_MIME,
      name: params.filename || params.title,
      meta: { slides }
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
      message: `Created the presentation "${file.name}" (${slides} slide${slides === 1 ? '' : 's'})${templateId ? ` on the "${templateId}" document template` : ''}${templateFile ? ` on the master and layouts of the uploaded "${templateFile.name}"` : ''}. The user sees a download card for it in the chat — do not add a link.`
    };
  } catch (error) {
    return toolFailure(error, 'The presentation could not be created.');
  }
}
