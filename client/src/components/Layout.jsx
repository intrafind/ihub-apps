import React, { useState, useEffect } from 'react';
import { Link, useLocation, Outlet } from 'react-router-dom';
import { useHeaderColor } from './HeaderColorContext';
import LanguageSelector from './LanguageSelector';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../utils/localizeContent';

const Layout = () => {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const { headerColor } = useHeaderColor();
  const [uiConfig, setUiConfig] = useState(null);
  const location = useLocation();
  const [translationsLoaded, setTranslationsLoaded] = useState(false);

  const headerColorStyle = {
    backgroundColor: headerColor || '#4f46e5',
    transition: 'background-color 0.3s ease'
  };

  useEffect(() => {
    // Fetch UI configuration
    const fetchUiConfig = async () => {
      try {
        const response = await fetch('/api/ui');
        const data = await response.json();
        setUiConfig(data);
      } catch (error) {
        console.error('Error fetching UI configuration:', error);
      }
    };

    fetchUiConfig();
  }, []);

  // Effect to monitor translation loading completeness
  useEffect(() => {
    // Subscribe to i18next's "loaded" event
    const handleTranslationsLoaded = (loaded) => {
      if (loaded) {
        // Force a re-render when translations are fully loaded
        setTranslationsLoaded(true);
        setTimeout(() => setTranslationsLoaded(false), 100);
      }
    };

    i18n.on('loaded', handleTranslationsLoaded);
    
    return () => {
      i18n.off('loaded', handleTranslationsLoaded);
    };
  }, [i18n]);

  return (
    <div className="flex flex-col min-h-screen">
      <header className="text-white py-4" style={headerColorStyle}>
        <div className="container mx-auto px-4 flex justify-between items-center">
          <Link to="/" className="text-2xl font-bold flex items-center">
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
            {uiConfig?.title ? getLocalizedContent(uiConfig.title, currentLanguage) : 'AI Hub'}
          </Link>

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
      </header>

      <main className="flex-grow container mx-auto px-4 py-6">
        <Outlet />
      </main>

      <footer className="bg-gray-800 text-white py-8">
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
          {uiConfig?.disclaimer && (
            <div className="mt-6 text-sm text-gray-400 border-t border-gray-700 pt-4">
              <p>{getLocalizedContent(uiConfig.disclaimer.text, currentLanguage)}</p>
            </div>
          )}
        </div>
      </footer>
    </div>
  );
};

export default Layout;