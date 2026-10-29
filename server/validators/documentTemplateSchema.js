// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { z } from 'zod';
import { HEX_COLOR_PATTERN, LANGUAGE_CODE_PATTERN } from '../../shared/validationPatterns.js';

/**
 * Document templates: a company's corporate design for the documents iHub
 * generates (PDF, Word, PowerPoint). One template is a directory
 * `contents/document-templates/<id>/` with a `template.json` (this schema) and
 * the files it names: a logo, brand fonts, a letterhead PDF, a Word template
 * and a PowerPoint template.
 */

export const TEMPLATE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Ids a template cannot have: the built-in PDF designs share the export's
 * `template` field, and `default` means "the default template" to the tools.
 */
export const RESERVED_TEMPLATE_IDS = Object.freeze(['default', 'professional', 'minimal', 'new']);

/** File name of an asset inside a template directory. */
export const ASSET_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,120}$/;

export const FONT_FACES = Object.freeze(['normal', 'bold', 'italics', 'bolditalics']);

/**
 * The files a template can hold, by slot: the extensions a slot accepts and
 * the name the file is stored under. Font files are stored per family and
 * face (`font-<family>-<face>.<ext>`).
 */
export const ASSET_SLOTS = Object.freeze({
  logo: { extensions: ['png', 'jpg', 'jpeg'], baseName: 'logo', maxBytes: 2 * 1024 * 1024 },
  letterhead: { extensions: ['pdf'], baseName: 'letterhead', maxBytes: 10 * 1024 * 1024 },
  letterheadFollowing: {
    extensions: ['pdf'],
    baseName: 'letterhead-following',
    maxBytes: 10 * 1024 * 1024
  },
  wordTemplate: {
    extensions: ['docx', 'dotx'],
    baseName: 'word-template',
    maxBytes: 20 * 1024 * 1024
  },
  powerpointTemplate: {
    extensions: ['pptx', 'potx'],
    baseName: 'powerpoint-template',
    maxBytes: 50 * 1024 * 1024
  },
  font: { extensions: ['ttf', 'otf'], baseName: 'font', maxBytes: 15 * 1024 * 1024 }
});

/** Slide layouts the PowerPoint engine places content on. */
export const SLIDE_LAYOUT_KINDS = Object.freeze([
  'title',
  'section',
  'content',
  'twoColumn',
  'titleOnly',
  'blank'
]);

const localizedString = z.record(
  z.string().regex(LANGUAGE_CODE_PATTERN, 'Invalid language code'),
  z.string().max(500)
);

const color = z.string().regex(HEX_COLOR_PATTERN, 'Colours are hex values like #e30613');

const assetName = z.string().regex(ASSET_NAME_PATTERN, 'Invalid file name');

/** A font family name: what Word and PowerPoint show, and what PDFs embed. */
const fontFamily = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[\p{L}\p{N} ._-]+$/u, 'Font names use letters, digits, spaces, dots and dashes');

const margins = z
  .array(z.number().min(18).max(200))
  .length(4, 'Margins are [left, top, right, bottom] in points');

const fontSchema = z
  .object({
    family: fontFamily,
    normal: assetName,
    bold: assetName.optional(),
    italics: assetName.optional(),
    bolditalics: assetName.optional()
  })
  .strict();

const brandSchema = z
  .object({
    primaryColor: color.optional(),
    accentColor: color.optional(),
    textColor: color.optional(),
    headingFont: fontFamily.optional(),
    bodyFont: fontFamily.optional(),
    fontSize: z.number().min(7).max(16).optional(),
    logo: assetName.optional(),
    companyName: z.string().max(200).optional()
  })
  .strict();

const documentSchema = z
  .object({
    pageSize: z.enum(['A4', 'LETTER', 'LEGAL', 'A3', 'A5']).optional(),
    orientation: z.enum(['portrait', 'landscape']).optional(),
    margins: margins.optional(),
    header: z.string().max(300).optional(),
    footer: z.string().max(300).optional(),
    pageNumbers: z.boolean().optional(),
    logoPosition: z.enum(['header-left', 'header-right', 'none']).optional(),
    logoWidth: z.number().min(20).max(300).optional(),
    coverLogo: z.boolean().optional()
  })
  .strict();

const pdfSchema = z
  .object({
    theme: z.enum(['default', 'professional', 'minimal']).optional(),
    letterhead: assetName.optional(),
    letterheadFollowing: assetName.optional()
  })
  .strict();

const docxSchema = z
  .object({
    template: assetName.optional()
  })
  .strict();

const pptxSchema = z
  .object({
    template: assetName.optional(),
    aspectRatio: z.enum(['16:9', '4:3']).optional(),
    footer: z.string().max(200).optional(),
    slideNumbers: z.boolean().optional(),
    layouts: z
      .object(Object.fromEntries(SLIDE_LAYOUT_KINDS.map(kind => [kind, z.string().max(200)])))
      .partial()
      .strict()
      .optional()
  })
  .strict();

export const documentTemplateSchema = z
  .object({
    id: z
      .string()
      .regex(TEMPLATE_ID_PATTERN, 'Template ids use a-z, 0-9 and "-"')
      .refine(id => !RESERVED_TEMPLATE_IDS.includes(id), {
        message: 'This id is reserved; choose another one'
      }),
    name: localizedString.refine(value => Object.values(value).some(v => v.trim()), {
      message: 'A template needs a name'
    }),
    description: localizedString.optional(),
    enabled: z.boolean().optional().default(true),
    default: z.boolean().optional().default(false),
    brand: brandSchema.optional().default({}),
    fonts: z.array(fontSchema).max(4).optional().default([]),
    document: documentSchema.optional().default({}),
    pdf: pdfSchema.optional().default({}),
    docx: docxSchema.optional().default({}),
    pptx: pptxSchema.optional().default({})
  })
  .strict()
  .superRefine((template, ctx) => {
    // A file named in a slot must be of the kind that slot takes.
    const slotFiles = [
      ['logo', ['brand', 'logo'], template.brand?.logo],
      ['letterhead', ['pdf', 'letterhead'], template.pdf?.letterhead],
      ['letterheadFollowing', ['pdf', 'letterheadFollowing'], template.pdf?.letterheadFollowing],
      ['wordTemplate', ['docx', 'template'], template.docx?.template],
      ['powerpointTemplate', ['pptx', 'template'], template.pptx?.template],
      ...template.fonts.flatMap((font, index) =>
        FONT_FACES.map(face => ['font', ['fonts', index, face], font[face]])
      )
    ];
    for (const [slot, path, name] of slotFiles) {
      if (!name) continue;
      const extension = name.split('.').pop();
      if (!ASSET_SLOTS[slot].extensions.includes(extension)) {
        ctx.addIssue({ code: 'custom', path, message: `Not a ${slot} file: ${name}` });
      }
    }
    const families = new Set();
    for (const [index, font] of template.fonts.entries()) {
      const key = font.family.toLowerCase();
      if (families.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['fonts', index, 'family'],
          message: `Font family "${font.family}" is listed twice`
        });
      }
      families.add(key);
    }
  });

/**
 * The asset file names a template refers to.
 *
 * @param {Object} template - A parsed template.
 * @returns {string[]}
 */
export function referencedAssets(template) {
  const names = [
    template.brand?.logo,
    template.pdf?.letterhead,
    template.pdf?.letterheadFollowing,
    template.docx?.template,
    template.pptx?.template
  ];
  for (const font of template.fonts || []) {
    for (const face of FONT_FACES) names.push(font[face]);
  }
  return names.filter(Boolean);
}
