import React, { useState, useEffect } from 'react';
import { Outlet, Link } from 'react-router-dom';
import { fetchUIConfig } from '../api/api';
import { useHeaderColor } from './HeaderColorContext';

const Layout = () => {
  const [uiConfig, setUiConfig] = useState({
    title: 'AI Hub Apps',
    header: { links: [] },
    footer: { text: '', links: [] },
    disclaimer: null
  });
  const [showDisclaimer, setShowDisclaimer] = useState(false);
  const { headerColor } = useHeaderColor();

  useEffect(() => {
    const loadUIConfig = async () => {
      try {
        const data = await fetchUIConfig();
        setUiConfig(data);
        
        // Show disclaimer if it hasn't been acknowledged
        if (data.disclaimer) {
          const acknowledged = localStorage.getItem('disclaimerAcknowledged');
          if (!acknowledged || acknowledged !== data.disclaimer.version) {
            setShowDisclaimer(true);
          }
        }
      } catch (error) {
        console.error('Error loading UI configuration:', error);
      }
    };
    
    loadUIConfig();
  }, []);

  const acknowledgeDisclaimer = () => {
    if (uiConfig.disclaimer) {
      localStorage.setItem('disclaimerAcknowledged', uiConfig.disclaimer.version);
    }
    setShowDisclaimer(false);
  };

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Header with dynamic background color */}
      <header style={{ backgroundColor: headerColor }} className="shadow-md transition-colors duration-300">
        <div className="container mx-auto px-4 py-4 flex justify-between items-center">
          <Link to="/" className="text-white text-2xl font-bold flex items-center">
            <svg className="w-8 h-8 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            {uiConfig.title}
          </Link>
          <nav>
            <ul className="flex space-x-6">
              {uiConfig.header.links.map((link, index) => (
                <li key={index}>
                  {link.url.startsWith('/') ? (
                    <Link to={link.url} className="text-white hover:text-opacity-80">
                      {link.name}
                    </Link>
                  ) : (
                    <a 
                      href={link.url} 
                      className="text-white hover:text-opacity-80" 
                      target="_blank" 
                      rel="noopener noreferrer"
                    >
                      {link.name}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-8">
        <Outlet />
      </main>

      {/* Footer */}
      <footer className="bg-gray-800 text-white py-6">
        <div className="container mx-auto px-4">
          <div className="text-center">
            <p className="mb-2">
              {uiConfig.footer.text || `© ${new Date().getFullYear()} ${uiConfig.title}. All rights reserved.`}
            </p>
            {uiConfig.footer.links && uiConfig.footer.links.length > 0 && (
              <div className="flex justify-center space-x-4 text-sm">
                {uiConfig.footer.links.map((link, index) => (
                  <React.Fragment key={index}>
                    {index > 0 && <span className="text-gray-400">|</span>}
                    {link.url.startsWith('/') ? (
                      <Link to={link.url} className="text-gray-300 hover:text-white mx-2">
                        {link.name}
                      </Link>
                    ) : (
                      <a 
                        href={link.url} 
                        className="text-gray-300 hover:text-white mx-2" 
                        target="_blank" 
                        rel="noopener noreferrer"
                      >
                        {link.name}
                      </a>
                    )}
                  </React.Fragment>
                ))}
              </div>
            )}
          </div>
        </div>
      </footer>

      {/* Disclaimer Modal */}
      {showDisclaimer && uiConfig.disclaimer && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-8 max-w-2xl mx-4">
            <h2 className="text-2xl font-bold mb-4">Disclaimer</h2>
            <div className="mb-6 max-h-96 overflow-y-auto">
              <p>{uiConfig.disclaimer.text}</p>
            </div>
            <div className="flex justify-end">
              <button
                onClick={acknowledgeDisclaimer}
                className="bg-indigo-600 text-white px-4 py-2 rounded hover:bg-indigo-700"
              >
                I Understand
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Layout;