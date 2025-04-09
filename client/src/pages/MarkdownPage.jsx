import React, { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { useParams, Navigate } from 'react-router-dom';
import { fetchUIConfig } from '../api/api';
import LoadingSpinner from '../components/LoadingSpinner';

const MarkdownPage = () => {
  const { pageId } = useParams();
  const [pageContent, setPageContent] = useState('');
  const [title, setTitle] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    const fetchPageContent = async () => {
      try {
        setLoading(true);
        const uiConfig = await fetchUIConfig();
        
        if (uiConfig?.pages && uiConfig.pages[pageId]) {
          setPageContent(uiConfig.pages[pageId].content);
          setTitle(uiConfig.pages[pageId].title || pageId.charAt(0).toUpperCase() + pageId.slice(1));
        } else {
          console.error(`Page content not found for: ${pageId}`);
          setNotFound(true);
        }
      } catch (err) {
        console.error(`Error loading page content for ${pageId}:`, err);
        setError(`Failed to load ${pageId} content. Please try again later.`);
      } finally {
        setLoading(false);
      }
    };

    fetchPageContent();
  }, [pageId]);

  if (notFound) {
    return <Navigate to="/not-found" replace />;
  }

  if (loading) {
    return <LoadingSpinner message={`Loading ${pageId} content...`} />;
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
          <ReactMarkdown>{pageContent}</ReactMarkdown>
        </article>
      </div>
    </div>
  );
};

export default MarkdownPage;