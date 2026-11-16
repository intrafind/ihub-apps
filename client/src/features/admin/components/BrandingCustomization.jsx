// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';
import EuAiActCard from './euAiAct/EuAiActCard';
import LocalizedWithDefaultField from './LocalizedWithDefaultField';
import PwaCustomization from './PwaCustomization';
import { HELP_CLASS, INPUT_CLASS, LABEL_CLASS, SECONDARY_BUTTON_CLASS } from './formStyles';

/**
 * The Branding tab: everything that says what the product is called and how it
 * looks at a glance. The product name has one home; the browser tab, the
 * exports, the sign-in screen and the installed app (PWA) follow it unless a
 * field here says otherwise.
 *
 * @param {Object} props
 * @param {Object} props.config - The whole ui.json
 * @param {(section: string, updates: Object) => void} props.onUpdate - Merge `updates` into a section
 * @param {(key: string, value: *) => void} props.onSet - Replace a top-level value (`title`)
 */
function BrandingCustomization({ config, onUpdate, onSet, t }) {
  const header = config.header || {};
  const hasSplitBrand = Boolean(header.titleLight || header.titleBold);

  return (
    <div className="space-y-6">
      <EuAiActCard
        id="product-name"
        title={t('admin.ui.branding.nameTitle', 'Product name')}
        description={t(
          'admin.ui.branding.nameDescription',
          'What your installation is called: in the browser tab, in exports, on the sign-in screen and as the name of the installed app.'
        )}
      >
        <div className="space-y-6">
          <LocalizedWithDefaultField
            label={t('admin.ui.branding.siteTitle', 'Site title')}
            hint={t(
              'admin.ui.branding.siteTitleHint',
              'Shown in the browser tab, in chat exports and on the sign-in screen.'
            )}
            value={config.title}
            onChange={title => onSet('title', title)}
          />

          <details className="group" open={hasSplitBrand}>
            <summary className="cursor-pointer text-sm font-medium text-gray-700 dark:text-gray-300 rounded-md focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800">
              {t('admin.ui.branding.splitBrand', 'Advanced: brand text in the sidebar')}
            </summary>
            <div className="mt-3 space-y-4">
              <p className={HELP_CLASS}>
                {t(
                  'admin.ui.branding.splitBrandHint',
                  'The sidebar shows the name in two weights: a light part and a bold part, joined without a space (put a leading space in the bold part if you need one). Clear both to show the site title instead.'
                )}
              </p>
              <DynamicLanguageEditor
                label={t('admin.ui.header.titleLight', 'Light part (e.g. "iHub")')}
                value={header.titleLight || {}}
                onChange={titleLight => onUpdate('header', { titleLight })}
                type="text"
                placeholder={{ en: 'e.g. iHub', de: 'z.B. iHub' }}
              />
              <DynamicLanguageEditor
                label={t('admin.ui.header.titleBold', 'Bold part (e.g. " Apps")')}
                value={header.titleBold || {}}
                onChange={titleBold => onUpdate('header', { titleBold })}
                type="text"
                placeholder={{ en: 'e.g.  Apps', de: 'z.B.  Apps' }}
              />
              {hasSplitBrand && (
                <button
                  type="button"
                  className={SECONDARY_BUTTON_CLASS}
                  onClick={() => onUpdate('header', { titleLight: {}, titleBold: {} })}
                >
                  {t('admin.ui.branding.useSiteTitle', 'Show the site title in the sidebar')}
                </button>
              )}
            </div>
          </details>

          <DynamicLanguageEditor
            label={t('admin.ui.header.tagline', 'Tagline')}
            value={header.tagline || {}}
            onChange={tagline => onUpdate('header', { tagline })}
            type="text"
            placeholder={{
              en: 'e.g. by YourCompany',
              de: 'z.B. von IhresFirma'
            }}
          />
        </div>
      </EuAiActCard>

      <EuAiActCard
        id="logo-and-icon"
        title={t('admin.ui.branding.logoTitle', 'Logo and icon')}
        description={t(
          'admin.ui.branding.logoDescription',
          'Upload images in the Assets tab, then enter their path here.'
        )}
      >
        <BrandImages config={config} onUpdate={onUpdate} t={t} />
      </EuAiActCard>

      <EuAiActCard
        id="install-as-app"
        title={t('admin.ui.pwa.title', 'Progressive Web App (PWA)')}
        description={t(
          'admin.ui.pwa.subtitle',
          'Allow users to install the app on their device home screen and enable offline fallback.'
        )}
      >
        <PwaCustomization
          config={config.pwa || {}}
          onUpdate={updates => onUpdate('pwa', updates)}
          t={t}
        />
      </EuAiActCard>
    </div>
  );
}

function BrandImages({ config, onUpdate, t }) {
  const header = config.header || {};
  return (
    <div className="space-y-6">
      {/* Logo Configuration */}
      <div>
        <label htmlFor="brand-logo-url" className={LABEL_CLASS}>
          {t('admin.ui.header.logoUrl', 'Logo URL')}
        </label>
        <input
          id="brand-logo-url"
          type="text"
          value={header.logo?.url || ''}
          onChange={e => onUpdate('header', { logo: { ...header.logo, url: e.target.value } })}
          placeholder="/header_company_logo.svg"
          aria-describedby="brand-logo-url-hint"
          className={INPUT_CLASS}
        />
        <p id="brand-logo-url-hint" className={HELP_CLASS}>
          {t(
            'admin.ui.header.logoUrlHint',
            'Enter the path to your logo file (e.g., /header_company_logo.svg)'
          )}
        </p>
      </div>

      <DynamicLanguageEditor
        label={t('admin.ui.header.logoAlt', 'Logo Alt Text')}
        value={header.logo?.alt || {}}
        onChange={alt => onUpdate('header', { logo: { ...header.logo, alt } })}
        type="text"
        placeholder={{ en: 'Logo alt text (en)', de: 'Logo alt text (de)' }}
      />

      {/* Favicon Configuration */}
      <div>
        <label htmlFor="brand-favicon" className={LABEL_CLASS}>
          {t('admin.ui.header.favicon', 'Favicon URL')}
        </label>
        <input
          id="brand-favicon"
          type="text"
          value={header.favicon || ''}
          onChange={e => onUpdate('header', { favicon: e.target.value })}
          placeholder="/favicon.ico"
          aria-describedby="brand-favicon-hint"
          className={INPUT_CLASS}
        />
        <p id="brand-favicon-hint" className={HELP_CLASS}>
          {t(
            'admin.ui.header.faviconHint',
            'Path to the browser tab icon (e.g., /favicon.ico or an uploaded asset). Leave empty to use the default.'
          )}
        </p>
      </div>
    </div>
  );
}

export default BrandingCustomization;
