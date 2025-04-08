import React from 'react';
import { Link } from 'react-router-dom';

const NotFound = () => {
  return (
    <div className="flex flex-col items-center justify-center py-12">
      <div className="text-indigo-600 mb-4">
        <svg className="w-24 h-24" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </div>
      <h1 className="text-4xl font-bold mb-2">404</h1>
      <p className="text-xl mb-6">Page Not Found</p>
      <p className="text-gray-600 mb-8 text-center max-w-md">
        The page you are looking for might have been removed or is temporarily unavailable.
      </p>
      <Link 
        to="/"
        className="bg-indigo-600 text-white px-6 py-3 rounded-lg hover:bg-indigo-700 transition-colors"
      >
        Back to Home
      </Link>
    </div>
  );
};

export default NotFound; 