// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import fontkit from '@pdf-lib/fontkit';
import { PDFDocument } from 'pdf-lib';
import { ASSET_SLOTS } from '../../../validators/documentTemplateSchema.js';
import { ContentTypes, openPackage, PackageError } from '../ooxml/opcPackage.js';

/**
 * Checks for the files an admin uploads into a document template.
 *
 * Every file is parsed the way the engines will use it, so a broken logo,
 * font, letterhead or Office template is refused at upload with a message
 * rather than failing every document later. Office files with macros are
 * refused: the engines never need them, and the generated documents must not
 * carry them.
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

const MAX_LOGO_PIXELS = 6000;

function imageInfo(buffer) {
  const isPng = buffer.length > 24 && buffer.readUInt32BE(0) === 0x89504e47;
  const isJpeg = buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8;
  if (isPng) {
    return { type: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (isJpeg) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      const isFrame =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) {
        return {
          type: 'jpeg',
          width: buffer.readUInt16BE(offset + 7),
          height: buffer.readUInt16BE(offset + 5)
        };
      }
      offset += 2 + length;
    }
    return { type: 'jpeg', width: 0, height: 0 };
  }
  return null;
}

function checkLogo(buffer, extension) {
  const info = imageInfo(buffer);
  if (!info) throw new TemplateAssetError('The logo must be a PNG or JPEG image.');
  const declared = extension === 'png' ? 'png' : 'jpeg';
  if (info.type !== declared) {
    throw new TemplateAssetError('The logo file does not match its extension.');
  }
  if (!(info.width > 0 && info.height > 0)) {
    throw new TemplateAssetError('The size of the logo image could not be read.');
  }
  if (info.width > MAX_LOGO_PIXELS || info.height > MAX_LOGO_PIXELS) {
    throw new TemplateAssetError(
      `The logo is too large (at most ${MAX_LOGO_PIXELS} pixels per side).`
    );
  }
  return { width: info.width, height: info.height, type: info.type };
}

function checkFont(buffer) {
  let font;
  try {
    font = fontkit.create(buffer);
  } catch {
    throw new TemplateAssetError('The font file could not be read (TrueType or OpenType).');
  }
  if (!font || typeof font.hasGlyphForCodePoint !== 'function') {
    throw new TemplateAssetError(
      'Font collections are not supported; upload one .ttf or .otf file per style.'
    );
  }
  if (!font.hasGlyphForCodePoint(0x41) || !font.hasGlyphForCodePoint(0x61)) {
    throw new TemplateAssetError('The font has no Latin letters.');
  }
  return {
    familyName: String(font.familyName || '').slice(0, 64),
    subfamilyName: String(font.subfamilyName || '').slice(0, 64),
    glyphs: font.numGlyphs
  };
}

async function checkPdf(buffer) {
  if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new TemplateAssetError('The letterhead must be a PDF file.');
  }
  let doc;
  try {
    doc = await PDFDocument.load(buffer, { updateMetadata: false });
  } catch (error) {
    throw new TemplateAssetError(
      /encrypt/i.test(error?.message || '')
        ? 'The letterhead PDF is encrypted; upload an unprotected file.'
        : 'The letterhead PDF could not be read.'
    );
  }
  const pages = doc.getPageCount();
  if (pages < 1) throw new TemplateAssetError('The letterhead PDF has no pages.');
  const { width, height } = doc.getPage(0).getSize();
  return { pages, width: Math.round(width), height: Math.round(height) };
}

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
 * @returns {Promise<Object>} What was found (image size, font name, page
 *   count, slide layouts …), for the admin page.
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
    case 'logo':
      return checkLogo(buffer, extension);
    case 'font':
      return checkFont(buffer);
    case 'letterhead':
    case 'letterheadFollowing':
      return checkPdf(buffer);
    case 'wordTemplate':
      return checkWordTemplate(buffer);
    case 'powerpointTemplate':
      return checkPowerpointTemplate(buffer);
    default:
      throw new TemplateAssetError(`Unknown template file slot "${slot}".`);
  }
}

export { imageInfo };
