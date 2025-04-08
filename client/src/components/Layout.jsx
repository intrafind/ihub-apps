import React, { useState, useEffect } from 'react';
import { Outlet, Link } from 'react-router-dom';
import { fetchDisclaimer } from '../api/api';

const Layout = () => {
  const [disclaimer, setDisclaimer] = useState(null);
  const [showDisclaimer, setShowDisclaimer] = useState(false);

  useEffect(() => {
    const loadDisclaimer = async () => {
      try {
        const data = await fetchDisclaimer();
        setDisclaimer(data);
        
        // Show disclaimer if it hasn't been acknowledged
        const acknowledged = localStorage.getItem('disclaimerAcknowledged');
        if (!acknowledged || acknowledged !== data.version) {
          setShowDisclaimer(true);
        }
      } catch (error) {
        console.error('Error loading disclaimer:', error);
      }
    };
    
    loadDisclaimer();
  }, []);

  const acknowledgeDisclaimer = () => {
    if (disclaimer) {
      localStorage.setItem('disclaimerAcknowledged', disclaimer.version);
    }
    setShowDisclaimer(false);
  };

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Header */}
      <header className="bg-indigo-600 shadow-md">
        <div className="container mx-auto px-4 py-4 flex justify-between items-center">
          <Link to="/" className="text-white text-2xl font-bold flex items-center">
            <svg className="w-8 h-8 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            AI Hub Apps
          </Link>
          <nav>
            <ul className="flex space-x-6">
              <li>
                <Link to="/" className="text-white hover:text-indigo-200">
                  Apps
                </Link>
              </li>
              <li>
                <Link to="/models/gpt-3.5-turbo" className="text-white hover:text-indigo-200">
                  Direct Chat
                </Link>
              </li>
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
          <p className="text-center text-sm">
            &copy; {new Date().getFullYear()} AI Hub Apps. All rights reserved.
          </p>
        </div>
      </footer>

      {/* Disclaimer Modal */}
      {showDisclaimer && disclaimer && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-8 max-w-2xl mx-4">
            <h2 className="text-2xl font-bold mb-4">Disclaimer</h2>
            <div className="mb-6 max-h-96 overflow-y-auto">
              <p>{disclaimer.text}</p>
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