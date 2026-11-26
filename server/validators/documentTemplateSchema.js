// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { z } from 'zod';
import { HEX_COLOR_PATTERN, LANGUAGE_CODE_PATTERN } from '../../shared/validationPatterns.js';

/**
 * Document templates: a company's corporate design for the documents iHub
 * generates (PDF, Word, PowerPoint, Excel). One template is a directory
 * `contents/document-templates/<id>/` with a `template.json` (this schema) and
 * the files it names: a Word template and a PowerPoint template. The design
 * lives in those files; the template adds the company name, the brand colours
 * (read from the files when not set), the margins of PDFs and the fields of
 * its Word template.
 */

export const TEMPLATE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Ids a template cannot have: `default` means "the default template" to the
 * tools and the export, `professional` and `minimal` are built-in designs of
 * the chat export (a request that names them gets the design, not a template),
 * and `new` is the editor's route for a new template.
 */
export const RESERVED_TEMPLATE_IDS = Object.freeze(['default', 'professional', 'minimal', 'new']);

/** File name of an asset inside a template directory. */
export const ASSET_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,120}$/;

/**
 * The placeholders every Word template can use, written `{{name}}`. Any
 * other name in a template's Word file is a custom field of the template.
 */
export const BUILT_IN_PLACEHOLDERS = Object.freeze([
  'content',
  'toc',
  'title',
  'subtitle',
  'author',
  'date',
  'year',
  'company',
  'page',
  'pages'
]);

/** Names of custom fields: a letter, then letters, digits or underscores; lower case. */
export const FIELD_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

/** At most this many custom fields per template. */
export const MAX_TEMPLATE_FIELDS = 50;

/** The files a template can hold, by slot: the extensions a slot accepts and the name the file is stored under. */
export const ASSET_SLOTS = Object.freeze({
  wordTemplate: {
    extensions: ['docx', 'dotx'],
    baseName: 'word-template',
    maxBytes: 20 * 1024 * 1024
  },
  powerpointTemplate: {
    extensions: ['pptx', 'potx'],
    baseName: 'powerpoint-template',
    maxBytes: 50 * 1024 * 1024
  }
});

const localizedString = z.record(
  z.string().regex(LANGUAGE_CODE_PATTERN, 'Invalid language code'),
  z.string().max(500)
);

const color = z.string().regex(HEX_COLOR_PATTERN, 'Colours are hex values like #e30613');

const assetName = z.string().regex(ASSET_NAME_PATTERN, 'Invalid file name');

const margins = z
  .array(z.number().min(18).max(200))
  .length(4, 'Margins are [left, top, right, bottom] in points');

const brandSchema = z
  .object({
    primaryColor: color.optional(),
    accentColor: color.optional(),
    textColor: color.optional(),
    companyName: z.string().max(200).optional()
  })
  .strict();

const pdfSchema = z
  .object({
    /**
     * Page margins of PDFs, `[left, top, right, bottom]` in points. When
     * unset they come from the Word template's last section.
     */
    margins: margins.optional()
  })
  .strict();

const docxSchema = z
  .object({
    template: assetName.optional()
  })
  .strict();

const pptxSchema = z
  .object({
    template: assetName.optional()
  })
  .strict();

/**
 * A custom field of a template: a `{{name}}` in its Word file that the model
 * or the user fills in. A required field without a value stops the document;
 * the model is told to ask for it.
 */
const fieldSchema = z
  .object({
    label: localizedString.optional(),
    description: localizedString.optional(),
    required: z.boolean().optional(),
    /** The values a field may take; free text when unset. */
    options: z.array(z.string().trim().min(1).max(100)).min(1).max(50).optional(),
    default: z.string().trim().max(500).optional()
  })
  .strict()
  .superRefine((field, ctx) => {
    if (field.options && field.default !== undefined && !field.options.includes(field.default)) {
      ctx.addIssue({
        code: 'custom',
        path: ['default'],
        message: 'The default must be one of the options'
      });
    }
    if (field.options && new Set(field.options).size !== field.options.length) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'An option is listed twice' });
    }
  });

const fieldsSchema = z
  .record(z.string().regex(FIELD_NAME_PATTERN, 'Field names use a-z, 0-9 and "_"'), fieldSchema)
  .superRefine((fields, ctx) => {
    const names = Object.keys(fields);
    if (names.length > MAX_TEMPLATE_FIELDS) {
      ctx.addIssue({
        code: 'custom',
        message: `At most ${MAX_TEMPLATE_FIELDS} fields per template`
      });
    }
    for (const name of names) {
      if (BUILT_IN_PLACEHOLDERS.includes(name)) {
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message: `"${name}" is a built-in placeholder and cannot be a custom field`
        });
      }
    }
  });

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
    pdf: pdfSchema.optional().default({}),
    docx: docxSchema.optional().default({}),
    pptx: pptxSchema.optional().default({}),
    fields: fieldsSchema.optional().default({})
  })
  .strict()
  .superRefine((template, ctx) => {
    // A file named in a slot must be of the kind that slot takes.
    const slotFiles = [
      ['wordTemplate', ['docx', 'template'], template.docx?.template],
      ['powerpointTemplate', ['pptx', 'template'], template.pptx?.template]
    ];
    for (const [slot, path, name] of slotFiles) {
      if (!name) continue;
      const extension = name.split('.').pop();
      if (!ASSET_SLOTS[slot].extensions.includes(extension)) {
        ctx.addIssue({ code: 'custom', path, message: `Not a ${slot} file: ${name}` });
      }
    }
  });

/**
 * The asset file names a template refers to.
 *
 * @param {Object} template - A parsed template.
 * @returns {string[]}
 */
export function referencedAssets(template) {
  return [template.docx?.template, template.pptx?.template].filter(Boolean);
}
