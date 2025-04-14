import React from 'react';
import { Link, useLocation, Outlet } from 'react-router-dom';
import { useUIConfig } from './UIConfigContext';
import LanguageSelector from './LanguageSelector';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../utils/localizeContent';
import DisclaimerPopup from './DisclaimerPopup';

const Layout = () => {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const { headerColor, uiConfig } = useUIConfig();
  const location = useLocation();

  const headerColorStyle = {
    backgroundColor: headerColor || '#4f46e5',
    transition: 'background-color 0.3s ease'
  };

  // Function to render the header logo
  const renderAppIcon = () => {
    return (
      <svg 
        className="w-8 h-8 mr-2" 
        fill="none" 
        stroke="currentColor" 
        viewBox="0 0 24 24" 
        xmlns="http://www.w3.org/2000/svg"
      >
        <path 
          strokeLinecap="round" 
          strokeLinejoin="round" 
          strokeWidth={2} 
          d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" 
        />
      </svg>
    );
  };

  return (
    <div className="flex flex-col min-h-screen h-full w-full">
      {/* Disclaimer Popup */}
      {uiConfig?.disclaimer && (
        <DisclaimerPopup 
          disclaimer={uiConfig.disclaimer} 
          currentLanguage={currentLanguage} 
        />
      )}
      
      <header className="text-white sticky top-0 z-10" style={headerColorStyle}>
        <div className="relative flex items-stretch h-16">
          {/* Logo section - positioned absolutely to be flush with left edge */}
          {uiConfig?.header?.logo?.url && (
            <div className="absolute left-0 h-full flex items-center">
              <img 
                src={uiConfig.header.logo.url} 
                alt={getLocalizedContent(uiConfig.header.logo.alt, currentLanguage) || 'Organization Logo'} 
                className="h-full w-auto"
              />
            </div>
          )}
          
          <div className="container mx-auto px-4 flex justify-between items-center">
            <div className="flex items-center h-full">
              {/* Add padding-left if logo exists to prevent overlap */}
              <Link to="/" className={`text-2xl font-bold flex items-center py-4`}>
                {renderAppIcon()}
                {uiConfig?.title ? getLocalizedContent(uiConfig.title, currentLanguage) : 'AI Hub'}
              </Link>
            </div>

            <nav className="hidden md:flex items-center space-x-6">
              {uiConfig?.header?.links && uiConfig.header.links.map((link, index) => (
                <Link 
                  key={index}
                  to={link.url} 
                  className={`hover:text-white/80 ${location.pathname === link.url ? 'underline font-medium' : ''}`}
                  target={link.url.startsWith('http') ? '_blank' : undefined}
                  rel={link.url.startsWith('http') ? 'noopener noreferrer' : undefined}
                >
                  {getLocalizedContent(link.name, currentLanguage)}
                </Link>
              ))}
            </nav>

            <div className="flex items-center space-x-4">
              <LanguageSelector />
              <button className="md:hidden text-white">
                <svg 
                  className="w-6 h-6" 
                  fill="none" 
                  stroke="currentColor" 
                  viewBox="0 0 24 24" 
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path 
                    strokeLinecap="round" 
                    strokeLinejoin="round" 
                    strokeWidth={2} 
                    d="M4 6h16M4 12h16m-7 6h7" 
                  />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="flex-grow container mx-auto px-4 py-6 overflow-y-auto">
        <Outlet />
      </main>

      <footer className="bg-gray-800 text-white py-4">
        <div className="container mx-auto px-4">
          <div className="flex flex-col md:flex-row justify-between items-center">
            <div className="mb-4 md:mb-0">
              <p>{uiConfig?.footer?.text ? getLocalizedContent(uiConfig.footer.text, currentLanguage) : t('footer.copyright')}</p>
            </div>
            <div className="flex flex-wrap justify-center gap-4 md:gap-6">
              {uiConfig?.footer?.links && uiConfig.footer.links.map((link, index) => (
                <Link 
                  key={index}
                  to={link.url} 
                  className="hover:text-gray-300"
                  target={link.url.startsWith('http') || link.url.startsWith('mailto:') ? '_blank' : undefined}
                  rel={link.url.startsWith('http') ? 'noopener noreferrer' : undefined}
                >
                  {getLocalizedContent(link.name, currentLanguage)}
                </Link>
              ))}
            </div>
          </div>
          {/* Disclaimer removed from footer - now shown as a popup */}
        </div>
      </footer>
    </div>
  );
};

export default Layout;