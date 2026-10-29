// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { officeFontName } from '../officeFonts.js';
import { loadTemplateBundle, resolveTemplateId } from './DocumentTemplateService.js';
import { imageInfo } from './templateAssets.js';

/**
 * Apply a document template to a document before it is rendered.
 *
 * The template is the company's corporate design, so where it says something
 * it wins over what the model (or an export request) asked for: colours,
 * fonts, logo, page setup, running header and footer, letterhead. What the
 * template leaves open stays with the request.
 *
 * Runs on the main thread: it reads the template's files and passes them to
 * the render worker as `assets`, next to a spec that is still plain data.
 */

/**
 * The template bundle for a document, or null when none applies.
 *
 * @param {Object} params
 * @param {'pdf'|'docx'|'pptx'} params.format
 * @param {Object} [params.app] - App config (`documentTemplate` pins one).
 * @param {string} [params.requested] - Template id picked by the model or user.
 * @returns {Promise<{ template: Object, assets: Object } | null>}
 */
export async function templateBundleFor({ format, app, requested }) {
  const { id } = await resolveTemplateId({ app, requested });
  return id ? loadTemplateBundle(id, format) : null;
}

function dataUriOf(asset) {
  if (!asset?.data) return null;
  const type = asset.extension === 'png' ? 'png' : 'jpeg';
  return `data:image/${type};base64,${Buffer.from(asset.data).toString('base64')}`;
}

/**
 * Text with `{company}` filled in; other placeholders stay for the renderer.
 */
function withCompany(text, template) {
  if (typeof text !== 'string') return text;
  return text.replaceAll('{company}', template.brand.companyName || '');
}

/** A template setting when it is set, else the request's. */
function pick(templateValue, requestValue) {
  return templateValue !== undefined && templateValue !== null ? templateValue : requestValue;
}

/**
 * The logo settings shared by PDF and Word documents.
 *
 * @returns {{ image: string, position: string, width: number, onCover: boolean } | undefined}
 */
function logoSettings(bundle) {
  const image = dataUriOf(bundle.assets.logo);
  if (!image) return undefined;
  const { document } = bundle.template;
  return {
    image,
    position: document.logoPosition || 'header-right',
    width: document.logoWidth || 80,
    onCover: document.coverLogo !== false
  };
}

/**
 * Apply a template to a PDF spec.
 *
 * @param {import('../pdf/buildDocument.js').PdfSpec} spec
 * @param {{ template: Object, assets: Object } | null} bundle
 * @returns {{ spec: Object, assets: Object|undefined, templateId: string|null }}
 */
export function applyTemplateToPdfSpec(spec, bundle) {
  if (!bundle) return { spec, assets: undefined, templateId: null };
  const { template, assets } = bundle;
  const { brand, document, pdf } = template;
  const page = spec.page || {};
  const hasLetterhead = Boolean(assets.letterhead || assets.letterheadFollowing);
  const themeOptions = spec.themeOptions || {};
  return {
    templateId: template.id,
    spec: {
      ...spec,
      author: spec.author || brand.companyName || undefined,
      theme: pick(pdf.theme, spec.theme),
      themeOptions: {
        primaryColor: pick(brand.primaryColor, themeOptions.primaryColor),
        accentColor: pick(brand.accentColor, themeOptions.accentColor),
        textColor: brand.textColor,
        font: pick(brand.bodyFont, themeOptions.font),
        headingFont: brand.headingFont,
        fontSize: pick(brand.fontSize, themeOptions.fontSize)
      },
      page: {
        size: pick(document.pageSize, page.size),
        // A letterhead is drawn for one orientation; without one the request
        // may turn the page for a wide table.
        orientation: hasLetterhead
          ? document.orientation || 'portrait'
          : pick(page.orientation, document.orientation),
        margins: pick(document.margins, page.margins)
      },
      header: document.header !== undefined ? withCompany(document.header, template) : spec.header,
      footer: document.footer !== undefined ? withCompany(document.footer, template) : spec.footer,
      pageNumbers: pick(document.pageNumbers, spec.pageNumbers),
      logo: logoSettings(bundle)
    },
    assets: {
      fonts: assets.fonts || [],
      letterhead: assets.letterhead?.data,
      letterheadFollowing: assets.letterheadFollowing?.data
    }
  };
}

/**
 * Apply a template to a Word document spec. A Word template in the
 * document template wins over the brand settings for styles, header and
 * footer; the brand colours still colour tables and bullets.
 *
 * @param {import('../docx/buildDocx.js').DocxSpec} spec
 * @param {{ template: Object, assets: Object } | null} bundle
 * @returns {{ spec: Object, assets: Object|undefined, templateId: string|null }}
 */
export function applyTemplateToDocxSpec(spec, bundle) {
  if (!bundle) return { spec, assets: undefined, templateId: null };
  const { template, assets } = bundle;
  const { brand, document } = template;
  const page = spec.page || {};
  return {
    templateId: template.id,
    spec: {
      ...spec,
      author: spec.author || brand.companyName || undefined,
      company: brand.companyName || '',
      colors: {
        primary: pick(brand.primaryColor, spec.colors?.primary),
        accent: pick(brand.accentColor, spec.colors?.accent),
        text: pick(brand.textColor, spec.colors?.text)
      },
      fonts: {
        body: pick(brand.bodyFont, spec.fonts?.body),
        heading: pick(brand.headingFont, spec.fonts?.heading)
      },
      fontSize: pick(brand.fontSize, spec.fontSize),
      page: {
        size: pick(document.pageSize, page.size),
        orientation: pick(page.orientation, document.orientation),
        margins: pick(document.margins, page.margins)
      },
      header: document.header !== undefined ? withCompany(document.header, template) : spec.header,
      footer: document.footer !== undefined ? withCompany(document.footer, template) : spec.footer,
      pageNumbers: pick(document.pageNumbers, spec.pageNumbers),
      logo: logoSettings(bundle)
    },
    assets: assets.wordTemplate ? { wordTemplate: assets.wordTemplate.data } : undefined
  };
}

/**
 * Apply a template to a presentation spec. A PowerPoint template in the
 * document template is filled as it is; without one, iHub's built-in
 * template is made from the brand (colours, fonts, logo).
 *
 * @param {Object} spec - See `../pptx/buildPptx.js`.
 * @param {{ template: Object, assets: Object } | null} bundle
 * @returns {{ spec: Object, assets: Object|undefined, templateId: string|null }}
 */
export function applyTemplateToPptxSpec(spec, bundle) {
  if (!bundle) return { spec, assets: undefined, templateId: null };
  const { template, assets } = bundle;
  const { brand, pptx } = template;
  const logo = assets.logo?.data ? imageInfo(Buffer.from(assets.logo.data)) : null;
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
        bodyFont: officeFontName(brand.bodyFont, undefined),
        aspectRatio: pick(pptx.aspectRatio, spec.brand?.aspectRatio)
      },
      footer: pptx.footer !== undefined ? withCompany(pptx.footer, template) : spec.footer,
      slideNumbers: pick(pptx.slideNumbers, spec.slideNumbers),
      layouts: pptx.layouts
    },
    assets: {
      powerpointTemplate: assets.powerpointTemplate?.data,
      logo:
        logo && assets.logo
          ? {
              data: assets.logo.data,
              extension: logo.type === 'png' ? 'png' : 'jpeg',
              width: logo.width,
              height: logo.height
            }
          : undefined
    }
  };
}

export { dataUriOf, logoSettings, pick, withCompany };
