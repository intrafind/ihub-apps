// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../utils/localizeContent';
import { resolveTranslationRefs } from '../../utils/translationRefs';

/**
 * The configured product name: `header.titleLight` + `header.titleBold`
 * (two weights), falling back to a legacy `header.title`, then to the site
 * title (`title`, by default a reference to the product name), then to
 * "iHub Apps". One implementation for the sidebar, the mobile top bar and
 * anywhere else the brand is spelled out.
 */
export default function BrandTitle({ uiConfig, currentLanguage, className = '' }) {
  const { t } = useTranslation();
  const header = uiConfig?.header || {};
  if (header.titleLight || header.titleBold) {
    return (
      <span className={className}>
        <span className="font-light">
          {getLocalizedContent(header.titleLight, currentLanguage)}
        </span>
        <span className="font-extrabold">
          {getLocalizedContent(header.titleBold, currentLanguage)}
        </span>
      </span>
    );
  }
  if (header.title) {
    return (
      <span className={`font-semibold ${className}`}>
        {getLocalizedContent(header.title, currentLanguage)}
      </span>
    );
  }
  const siteTitle = resolveTranslationRefs(
    getLocalizedContent(uiConfig?.title, currentLanguage),
    t
  ).trim();
  if (siteTitle) {
    return <span className={`font-semibold ${className}`}>{siteTitle}</span>;
  }
  return (
    <span className={className}>
      <span className="font-light">iHub </span>
      <span className="font-extrabold">Apps</span>
    </span>
  );
}
