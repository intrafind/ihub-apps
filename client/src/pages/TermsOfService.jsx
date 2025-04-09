import React, { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { fetchUIConfig } from '../api/api';
import LoadingSpinner from '../components/LoadingSpinner';

const TermsOfService = () => {
  const [termsContent, setTermsContent] = useState('');
  const [title, setTitle] = useState('Terms of Service');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchTermsContent = async () => {
      try {
        setLoading(true);
        const uiConfig = await fetchUIConfig();
        
        if (uiConfig?.pages?.terms) {
          setTermsContent(uiConfig.pages.terms.content);
          if (uiConfig.pages.terms.title) {
            setTitle(uiConfig.pages.terms.title);
          }
        } else {
          setError('Terms of service content not found');
        }
      } catch (err) {
        console.error('Error loading terms of service:', err);
        setError('Failed to load terms of service. Please try again later.');
      } finally {
        setLoading(false);
      }
    };

    fetchTermsContent();
  }, []);

  if (loading) {
    return <LoadingSpinner message="Loading terms of service..." />;
  }

  if (error) {
    return (
      <div className="text-center py-12">
        <div className="text-red-500 mb-4">{error}</div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto">
      <div className="bg-white p-6 md:p-8 rounded-lg shadow-md">
        <article className="prose prose-slate lg:prose-lg max-w-none">
          <ReactMarkdown>{termsContent}</ReactMarkdown>
        </article>
      </div>
    </div>
  );
};

export default TermsOfService;