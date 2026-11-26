// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { ASSET_SLOTS } from '../../../validators/documentTemplateSchema.js';
import { ContentTypes, openPackage, PackageError } from '../ooxml/opcPackage.js';

/**
 * Checks for the files an admin uploads into a document template.
 *
 * Every file is parsed the way the engines will use it, so a broken Office
 * template is refused at upload with a message rather than failing every
 * document later. Office files with macros are refused: the engines never need
 * them, and the generated documents must not carry them.
 */

export class TemplateAssetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TemplateAssetError';
  }
}

const WORD_MAIN_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml'
]);

const POWERPOINT_MAIN_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  'application/vnd.openxmlformats-officedocument.presentationml.template.main+xml'
]);

async function officeMainType(buffer, mainPart, label) {
  let zip;
  try {
    zip = await openPackage(buffer);
  } catch (error) {
    throw new TemplateAssetError(
      error instanceof PackageError ? error.message : `The ${label} could not be read.`
    );
  }
  if (!zip.file(mainPart)) {
    throw new TemplateAssetError(`The file is not a ${label}.`);
  }
  let types;
  try {
    types = await ContentTypes.read(zip);
  } catch {
    throw new TemplateAssetError(`The ${label} has no content type list.`);
  }
  if (Object.keys(zip.files).some(name => /vbaProject\.bin$/i.test(name))) {
    throw new TemplateAssetError(`The ${label} contains macros; save it without macros.`);
  }
  return { zip, mainType: types.typeOf(mainPart) };
}

async function checkWordTemplate(buffer) {
  const { mainType } = await officeMainType(buffer, 'word/document.xml', 'Word template');
  if (!WORD_MAIN_TYPES.has(mainType)) {
    throw new TemplateAssetError(
      'Upload a Word document (.docx) or Word template (.dotx) without macros.'
    );
  }
  const { inspectWordTemplate } = await import('../docx/wordTemplate.js');
  try {
    return await inspectWordTemplate(buffer);
  } catch (error) {
    throw new TemplateAssetError(error?.message || 'The Word template could not be read.');
  }
}

async function checkPowerpointTemplate(buffer) {
  const { mainType } = await officeMainType(buffer, 'ppt/presentation.xml', 'PowerPoint template');
  if (!POWERPOINT_MAIN_TYPES.has(mainType)) {
    throw new TemplateAssetError(
      'Upload a PowerPoint presentation (.pptx) or template (.potx) without macros.'
    );
  }
  const { analyzePowerpointTemplate } = await import('../pptx/pptxTemplate.js');
  try {
    return await analyzePowerpointTemplate(buffer);
  } catch (error) {
    throw new TemplateAssetError(error?.message || 'The PowerPoint template could not be read.');
  }
}

/**
 * Check an uploaded file for a template slot.
 *
 * @param {keyof ASSET_SLOTS} slot
 * @param {Buffer} buffer
 * @param {string} extension - Lower-case, without the dot.
 * @returns {Promise<Object>} What was found (placeholders, styles, slide
 *   layouts …), for the admin page.
 * @throws {TemplateAssetError}
 */
export async function checkTemplateAsset(slot, buffer, extension) {
  const spec = ASSET_SLOTS[slot];
  if (!spec) throw new TemplateAssetError(`Unknown template file slot "${slot}".`);
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new TemplateAssetError('The uploaded file is empty.');
  }
  if (!spec.extensions.includes(extension)) {
    throw new TemplateAssetError(
      `This slot accepts ${spec.extensions.map(e => `.${e}`).join(', ')} files.`
    );
  }
  if (buffer.length > spec.maxBytes) {
    throw new TemplateAssetError(
      `The file is too large (at most ${Math.round(spec.maxBytes / 1024 / 1024)} MB).`
    );
  }
  switch (slot) {
    case 'wordTemplate':
      return checkWordTemplate(buffer);
    case 'powerpointTemplate':
      return checkPowerpointTemplate(buffer);
    default:
      throw new TemplateAssetError(`Unknown template file slot "${slot}".`);
  }
}
