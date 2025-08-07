import { useState, useMemo, useEffect } from 'react';
import { Link, useLocation, Outlet, useSearchParams } from 'react-router-dom';
import { useUIConfig } from '../contexts/UIConfigContext';
import LanguageSelector from './LanguageSelector';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../utils/localizeContent';
import DisclaimerPopup from './DisclaimerPopup';
import SmartSearch from './SmartSearch';
import { updateSettingsFromUrl, saveIntegrationSettings } from '../../utils/integrationSettings';
import Icon from './Icon';
import UserAuthMenu from '../../features/auth/components/UserAuthMenu';
import { useAuth } from '../contexts/AuthContext.jsx';

const Layout = () => {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const { headerColor, uiConfig, resetHeaderColor } = useUIConfig();
  const location = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [searchParams] = useSearchParams();
  const { user, isAuthenticated } = useAuth();

  // Update integration settings from URL parameters and retrieve current settings
  const { showHeader, showFooter, language } = updateSettingsFromUrl(searchParams);

  // Apply language from URL if specified
  useEffect(() => {
    if (language && language !== i18n.language) {
      console.log(`Setting language from URL parameter: ${language}`);
      i18n.changeLanguage(language);
    }
  }, [language, i18n]);

  // Check if we're viewing an app page to hide footer links
  const isAppPage = useMemo(() => {
    return location.pathname.startsWith('/apps/');
  }, [location.pathname]);

  // Store integration settings in localStorage for use by other components
  useEffect(() => {
    saveIntegrationSettings({ showHeader, showFooter, language });
  }, [showHeader, showFooter, language]);

  const headerColorStyle = {
    backgroundColor: headerColor || '#4f46e5',
    transition: 'background-color 0.3s ease'
  };

  const toggleMobileMenu = () => {
    setMobileMenuOpen(!mobileMenuOpen);
  };

  const canAccessLink = link => {
    if (!link.url.startsWith('/pages/') || !uiConfig?.pages) return true;
    const pageId = link.url.replace('/pages/', '');
    const page = uiConfig.pages[pageId];
    if (!page) return true;
    if (page.authRequired && !isAuthenticated) return false;
    if (Array.isArray(page.allowedGroups)) {
      if (page.allowedGroups.includes('*')) return true;
      if (page.allowedGroups.length > 0) {
        const groups = user?.groups || [];
        return groups.some(g => page.allowedGroups.includes(g));
      }
    }
    return true;
  };

  return (
    <div className="flex flex-col min-h-screen h-full w-full">
      {/* Disclaimer Popup - Only render if enabled (defaults to true) */}
      {uiConfig?.disclaimer && uiConfig.disclaimer.enabled !== false && (
        <DisclaimerPopup disclaimer={uiConfig.disclaimer} currentLanguage={currentLanguage} />
      )}

      {/* Global smart search overlay */}
      <SmartSearch />

      {showHeader && (
        <header className="text-white sticky top-0 z-10" style={headerColorStyle}>
          <div className="relative flex items-stretch h-16">
            {/* Logo section - positioned absolutely to be flush with left edge */}
            {uiConfig?.header?.logo?.url && (
              <div
                className="absolute left-0 h-full flex items-center"
                style={uiConfig.header.logo.containerStyle}
              >
                <img
                  src={uiConfig.header.logo.url}
                  alt={
                    getLocalizedContent(uiConfig.header.logo.alt, currentLanguage) ||
                    'Organization Logo'
                  }
                  className="h-full w-auto"
                  style={uiConfig.header.logo.imageStyle}
                />
              </div>
            )}

            <div className="container mx-auto px-4 flex justify-between items-center">
              <div className="flex items-center h-full">
                {/* Add padding-left if logo exists to prevent overlap */}
                <Link
                  to="/"
                  onClick={resetHeaderColor}
                  className={'text-2xl font-bold flex items-center py-4'}
                >
                  {uiConfig?.header?.title
                    ? getLocalizedContent(uiConfig.header.title, currentLanguage)
                    : 'iHub Apps'}
                </Link>
              </div>

              <nav className="hidden md:flex items-center space-x-6">
                {uiConfig?.header?.links &&
                  uiConfig.header.links
                    .filter(
                      link =>
                        !(link.url === '/prompts' && uiConfig?.promptsList?.enabled === false) &&
                        canAccessLink(link)
                    )
                    .map((link, index) => (
                      <Link
                        key={index}
                        to={link.url}
                        onClick={resetHeaderColor}
                        className={`hover:text-white/80 ${location.pathname === link.url ? 'underline font-medium' : ''}`}
                        target={link.url.startsWith('http') ? '_blank' : undefined}
                        rel={link.url.startsWith('http') ? 'noopener noreferrer' : undefined}
                      >
                        {getLocalizedContent(link.name, currentLanguage)}
                      </Link>
                    ))}
              </nav>

              <div className="flex items-center space-x-4">
                {uiConfig?.header?.languageSelector?.enabled !== false && <LanguageSelector />}
                <UserAuthMenu />
                <button
                  className="md:hidden text-white"
                  onClick={toggleMobileMenu}
                  aria-label={t('common.toggleMenu', 'Toggle menu')}
                >
                  <Icon name="menu" size="lg" className="text-white" />
                </button>
              </div>
            </div>
          </div>

          {/* Mobile Menu */}
          {mobileMenuOpen && (
            <div className="md:hidden bg-indigo-800 shadow-lg" style={headerColorStyle}>
              <nav className="container mx-auto px-4 py-3 flex flex-col">
                {uiConfig?.header?.links &&
                  uiConfig.header.links
                    .filter(
                      link =>
                        !(link.url === '/prompts' && uiConfig?.promptsList?.enabled === false) &&
                        canAccessLink(link)
                    )
                    .map((link, index) => (
                      <Link
                        key={index}
                        to={link.url}
                        className={`block py-2 ${location.pathname === link.url ? 'font-medium' : ''}`}
                        target={link.url.startsWith('http') ? '_blank' : undefined}
                        rel={link.url.startsWith('http') ? 'noopener noreferrer' : undefined}
                        onClick={() => {
                          setMobileMenuOpen(false);
                          resetHeaderColor();
                        }}
                      >
                        {getLocalizedContent(link.name, currentLanguage)}
                      </Link>
                    ))}
              </nav>
            </div>
          )}
        </header>
      )}

      <main className="flex-grow w-full overflow-y-auto">
        <div className="container mx-auto px-4">
          <Outlet />
        </div>
      </main>

      {/* Footer - Only render if enabled (defaults to true) */}
      {uiConfig?.footer?.enabled !== false && showFooter && (
        <footer className="bg-gray-800 text-white py-4">
          <div className="container mx-auto px-4">
            <div className="flex flex-col md:flex-row justify-between items-center">
              <div className="mb-4 md:mb-0">
                <p>
                  {uiConfig?.footer?.text
                    ? getLocalizedContent(uiConfig.footer.text, currentLanguage)
                    : t('footer.copyright')}
                </p>
              </div>
              {/* Only show footer links when NOT on an app page */}
              {!isAppPage && (
                <div className="flex flex-wrap justify-center gap-4 md:gap-6">
                  {uiConfig?.footer?.links &&
                    uiConfig.footer.links
                      .filter(link => canAccessLink(link))
                      .map((link, index) => (
                        <Link
                          key={index}
                          to={link.url}
                          onClick={resetHeaderColor}
                          className="hover:text-gray-300"
                          target={
                            link.url.startsWith('http') || link.url.startsWith('mailto:')
                              ? '_blank'
                              : undefined
                          }
                          rel={link.url.startsWith('http') ? 'noopener noreferrer' : undefined}
                        >
                          {getLocalizedContent(link.name, currentLanguage)}
                        </Link>
                      ))}
                </div>
              )}
            </div>
            {/* Disclaimer removed from footer - now shown as a popup */}
          </div>
        </footer>
      )}
    </div>
  );
};

export default Layout;
