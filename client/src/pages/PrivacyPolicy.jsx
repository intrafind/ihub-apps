import React, { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { fetchUIConfig } from '../api/api';
import LoadingSpinner from '../components/LoadingSpinner';

const PrivacyPolicy = () => {
  const [privacyContent, setPrivacyContent] = useState('');
  const [title, setTitle] = useState('Privacy Policy');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchPrivacyContent = async () => {
      try {
        setLoading(true);
        const uiConfig = await fetchUIConfig();
        
        if (uiConfig?.pages?.privacy) {
          setPrivacyContent(uiConfig.pages.privacy.content);
          if (uiConfig.pages.privacy.title) {
            setTitle(uiConfig.pages.privacy.title);
          }
        } else {
          setError('Privacy policy content not found');
        }
      } catch (err) {
        console.error('Error loading privacy policy:', err);
        setError('Failed to load privacy policy. Please try again later.');
      } finally {
        setLoading(false);
      }
    };

    fetchPrivacyContent();
  }, []);

  if (loading) {
    return <LoadingSpinner message="Loading privacy policy..." />;
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
          <ReactMarkdown>{privacyContent}</ReactMarkdown>
        </article>
      </div>
    </div>
  );
};

export default PrivacyPolicy;