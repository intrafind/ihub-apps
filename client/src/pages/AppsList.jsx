import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { fetchApps } from '../api/api';
import LoadingSpinner from '../components/LoadingSpinner';

const AppsList = () => {
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const loadApps = async () => {
      try {
        setLoading(true);
        const data = await fetchApps();
        setApps(data);
        setError(null);
      } catch (err) {
        console.error('Error loading apps:', err);
        setError('Failed to load apps. Please try again later.');
      } finally {
        setLoading(false);
      }
    };

    loadApps();
  }, []);

  if (loading) {
    return <LoadingSpinner message="Loading apps..." />;
  }

  if (error) {
    return (
      <div className="text-center py-12">
        <div className="text-red-500 mb-4">{error}</div>
        <button 
          className="bg-indigo-600 text-white px-4 py-2 rounded hover:bg-indigo-700"
          onClick={() => window.location.reload()}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-[calc(100vh-12rem)]">
      <h1 className="text-3xl font-bold mb-8 text-center">AI Applications</h1>
      
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 flex-grow">
        {apps.map(app => (
          <Link 
            key={app.id}
            to={`/apps/${app.id}`}
            className="block"
          >
            <div 
              className="bg-white rounded-lg shadow-md overflow-hidden hover:shadow-lg transition-shadow duration-300"
              style={{ borderTop: `4px solid ${app.color}` }}
            >
              <div className="p-6">
                <div className="flex items-center mb-4">
                  <div 
                    className="w-10 h-10 rounded-full flex items-center justify-center mr-3"
                    style={{ backgroundColor: app.color }}
                  >
                    <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                    </svg>
                  </div>
                  <h2 className="text-xl font-semibold">{app.name}</h2>
                </div>
                <p className="text-gray-600">{app.description}</p>
              </div>
              <div className="px-6 py-3 bg-gray-50 text-sm">
                <div className="flex justify-between items-center">
                  <span className="text-gray-500">Model: {app.preferredModel}</span>
                  <span className="bg-indigo-100 text-indigo-800 px-2 py-1 rounded text-xs">
                    Try It
                  </span>
                </div>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
};

export default AppsList;