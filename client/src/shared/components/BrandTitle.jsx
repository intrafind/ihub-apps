import { getLocalizedContent } from '../../utils/localizeContent';

/**
 * The configured product name: `header.titleLight` + `header.titleBold`
 * (two weights), falling back to a legacy `header.title`, then to
 * "iHub Apps". One implementation for the sidebar, the mobile top bar and
 * anywhere else the brand is spelled out.
 */
export default function BrandTitle({ uiConfig, currentLanguage, className = '' }) {
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
  return (
    <span className={className}>
      <span className="font-light">iHub </span>
      <span className="font-extrabold">Apps</span>
    </span>
  );
}
