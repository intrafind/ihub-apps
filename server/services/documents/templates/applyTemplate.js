// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { officeFontName } from '../officeFonts.js';
import { loadTemplateBundle, resolveTemplateId } from './DocumentTemplateService.js';
import { resolveFieldValues } from './templateFields.js';
import { specifiedBrand } from './themeBrand.js';

/**
 * Apply a document template to a document before it is rendered.
 *
 * The template is the company's corporate design, so where it says something
 * it wins over what the model (or an export request) asked for: colours,
 * fonts, page setup. The design lives in the template's Word and PowerPoint
 * files; the colours and fonts the template does not set come from their
 * themes (`themeBrand.js`). What the template leaves open stays with the
 * request.
 *
 * Runs on the main thread: it reads the template's files and passes them to
 * the render worker as `assets`, next to a spec that is still plain data.
 */

/**
 * The template bundle for a document, or null when none applies.
 *
 * @param {Object} params
 * @param {'pdf'|'docx'|'pptx'|'xlsx'} params.format
 * @param {Object} [params.app] - App config (`documentTemplate` pins one).
 * @param {string} [params.requested] - Template id picked by the model or user.
 * @returns {Promise<{ template: Object, assets: Object } | null>}
 */
export async function templateBundleFor({ format, app, requested }) {
  const { id } = await resolveTemplateId({ app, requested });
  return id ? loadTemplateBundle(id, format) : null;
}

/**
 * The template's brand settings (company name and colours), with the colours
 * and fonts its Word and PowerPoint themes give where the template sets none.
 * The neutral defaults are left out, so that a request's own colours still
 * apply to a template that has no colours at all.
 */
function brandOf(bundle) {
  return { ...bundle.template.brand, ...specifiedBrand(bundle.brand) };
}

/** A template setting when it is set, else the request's. */
function pick(templateValue, requestValue) {
  return templateValue !== undefined && templateValue !== null ? templateValue : requestValue;
}

/**
 * Apply a template to a PDF spec. A PDF is made by the PDF engine, not from
 * the Word file: it takes the brand colours, the page of the Word template
 * (format, orientation, margins) and a footer with the company name.
 *
 * @param {import('../pdf/buildDocument.js').PdfSpec} spec
 * @param {{ template: Object, assets: Object } | null} bundle
 * @returns {{ spec: Object, assets: Object|undefined, templateId: string|null }}
 */
export function applyTemplateToPdfSpec(spec, bundle) {
  if (!bundle) return { spec, assets: undefined, templateId: null };
  const { template, pdfPage = {} } = bundle;
  const brand = brandOf(bundle);
  const page = spec.page || {};
  const themeOptions = spec.themeOptions || {};
  return {
    templateId: template.id,
    spec: {
      ...spec,
      author: spec.author || brand.companyName || undefined,
      themeOptions: {
        primaryColor: pick(brand.primaryColor, themeOptions.primaryColor),
        accentColor: pick(brand.accentColor, themeOptions.accentColor),
        textColor: brand.textColor,
        font: pick(brand.bodyFont, themeOptions.font),
        headingFont: brand.headingFont
      },
      page: {
        // The template's format and margins win; the request may turn the
        // page, for a wide table.
        size: pick(pdfPage.size, page.size),
        orientation: pick(page.orientation, pdfPage.orientation),
        margins: pick(pdfPage.margins, page.margins)
      },
      footer: spec.footer !== undefined ? spec.footer : brand.companyName || undefined
    },
    assets: undefined
  };
}

/**
 * Apply a template to a Word document spec. A Word template in the document
 * template wins over the brand for styles, header and footer; the brand
 * colours still colour tables and bullets.
 *
 * @param {import('../docx/buildDocx.js').DocxSpec} spec
 * @param {{ template: Object, assets: Object } | null} bundle
 * @returns {{ spec: Object, assets: Object|undefined, templateId: string|null }}
 */
export function applyTemplateToDocxSpec(spec, bundle) {
  if (!bundle) return { spec, assets: undefined, templateId: null };
  const { template, assets } = bundle;
  const brand = brandOf(bundle);
  return {
    templateId: template.id,
    spec: {
      ...spec,
      author: spec.author || brand.companyName || undefined,
      company: brand.companyName || '',
      // The values of the template's own fields: what was given, else the defaults.
      fields: resolveFieldValues(template.fields, spec.fields).values,
      colors: {
        primary: pick(brand.primaryColor, spec.colors?.primary),
        accent: pick(brand.accentColor, spec.colors?.accent),
        text: pick(brand.textColor, spec.colors?.text)
      },
      fonts: {
        body: pick(brand.bodyFont, spec.fonts?.body),
        heading: pick(brand.headingFont, spec.fonts?.heading)
      },
      // Without a Word template the document is built from the brand: a footer with the company name.
      footer: spec.footer !== undefined ? spec.footer : brand.companyName || undefined
    },
    assets: assets.wordTemplate ? { wordTemplate: assets.wordTemplate.data } : undefined
  };
}

/**
 * Apply a template to a presentation spec. A PowerPoint template in the
 * document template is filled as it is; without one, iHub's built-in
 * template is made from the brand (colours, fonts).
 *
 * @param {Object} spec - See `../pptx/buildPptx.js`.
 * @param {{ template: Object, assets: Object } | null} bundle
 * @returns {{ spec: Object, assets: Object|undefined, templateId: string|null }}
 */
export function applyTemplateToPptxSpec(spec, bundle) {
  if (!bundle) return { spec, assets: undefined, templateId: null };
  const { template, assets } = bundle;
  const brand = brandOf(bundle);
  return {
    templateId: template.id,
    spec: {
      ...spec,
      author: spec.author || brand.companyName || undefined,
      brand: {
        ...spec.brand,
        primaryColor: pick(brand.primaryColor, spec.brand?.primaryColor),
        accentColor: pick(brand.accentColor, spec.brand?.accentColor),
        textColor: brand.textColor,
        headingFont: officeFontName(brand.headingFont || brand.bodyFont, undefined),
        bodyFont: officeFontName(brand.bodyFont, undefined)
      }
    },
    assets: { powerpointTemplate: assets.powerpointTemplate?.data }
  };
}

/**
 * Apply a template to an Excel workbook spec: brand colours, body font and
 * company metadata.
 *
 * @param {Object} spec - See `../xlsx/buildXlsx.js`.
 * @param {{ template: Object, assets: Object } | null} bundle
 * @returns {{ spec: Object, assets: Object|undefined, templateId: string|null }}
 */
export function applyTemplateToXlsxSpec(spec, bundle) {
  if (!bundle) return { spec, assets: undefined, templateId: null };
  const { template } = bundle;
  const brand = brandOf(bundle);
  return {
    templateId: template.id,
    spec: {
      ...spec,
      author: spec.author || brand.companyName || undefined,
      company: brand.companyName || '',
      brand: {
        ...spec.brand,
        primaryColor: pick(brand.primaryColor, spec.brand?.primaryColor),
        accentColor: pick(brand.accentColor, spec.brand?.accentColor),
        textColor: brand.textColor,
        font: officeFontName(pick(brand.bodyFont, spec.brand?.font), undefined)
      }
    },
    assets: undefined
  };
}

export { pick };
