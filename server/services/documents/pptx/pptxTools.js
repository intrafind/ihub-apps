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
export async function createPptx(spec, { app, template } = {}) {
  const bundle = await templateBundleFor({ format: 'pptx', app, requested: template });
  const applied = applyTemplateToPptxSpec(spec, bundle);
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
 * `create_pptx`: build the presentation and hand it to the chat.
 *
 * @param {Object} params - Tool arguments plus the trusted context (`user`,
 *   `chatId`, `appConfig`).
 * @returns {Promise<Object>}
 */
export async function runCreatePptx(params) {
  try {
    const spec = pptxSpecFromToolArgs(params);
    const { buffer, slides, warnings, templateId } = await createPptx(spec, {
      app: params.appConfig,
      template: params.template
    });
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
      ...(warnings.length ? { warnings } : {}),
      message: `Created the presentation "${file.name}" (${slides} slide${slides === 1 ? '' : 's'})${templateId ? ` on the "${templateId}" document template` : ''}. The user sees a download card for it in the chat — do not add a link.`
    };
  } catch (error) {
    return toolFailure(error, 'The presentation could not be created.');
  }
}
