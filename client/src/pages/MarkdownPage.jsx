import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import LoadingSpinner from '../shared/components/LoadingSpinner';
import { marked } from 'marked';
import { fetchPageContent } from '../api/api';
import MarkdownRenderer, { configureMarked } from '../shared/components/MarkdownRenderer';

const MarkdownPage = () => {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const navigate = useNavigate();
  const { pageId } = useParams();
  const [pageTitle, setPageTitle] = useState('');
  const [markdownContent, setMarkdownContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Configure marked options when component mounts
  useEffect(() => {
    configureMarked();
  }, []);

  useEffect(() => {
    const loadPageContent = async() => {
      try {
        setLoading(true);

        // Use the API service to fetch page content
        const pageData = await fetchPageContent(pageId, { language: currentLanguage });

        setPageTitle(pageData.title || '');
        setMarkdownContent(pageData.content || '');
        setError(null);
      } catch (err) {
        console.error('Error fetching page:', err);

        // Use the enhanced error info from the API service
        if (err.status === 404) {
          setError('Page not found');
        } else {
          setError(`Failed to load page: ${err.message}`);
        }
      } finally {
        setLoading(false);
      }
    };

    loadPageContent();
  }, [pageId, currentLanguage]);

  if (loading) {
    return <LoadingSpinner message={t('app.loading')} />;
  }

  if (error) {
    return (
      <div className="text-center py-12">
        <div className="text-red-500 mb-4">{error}</div>
        <button
          className="bg-gray-600 text-white px-4 py-2 rounded hover:bg-gray-700"
          onClick={() => navigate('/')}
        >
          {t('common.back')}
        </button>
      </div>
    );
  }

  // Parse the markdown content using marked
  const parsedContent = marked(markdownContent || '');

  return (
    <div className="container mx-auto py-8 px-4 max-w-4xl">
      <MarkdownRenderer />
      <div className="prose prose-sm sm:prose lg:prose-lg mx-auto">
        <div className="markdown-content" dangerouslySetInnerHTML={{ __html: parsedContent }}></div>
      </div>
    </div>
  );
};

export default MarkdownPage;
