import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import LoadingSpinner from '../shared/components/LoadingSpinner';
import { marked } from 'marked';
import { fetchPageContent } from '../api/api';
import { configureMarked } from '../shared/components/MarkdownRenderer';
import ReactComponentRenderer from '../shared/components/ReactComponentRenderer';

const UnifiedPage = () => {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const navigate = useNavigate();
  const { pageId } = useParams();
  const [, setPageTitle] = useState('');
  const [pageContent, setPageContent] = useState('');
  const [contentType, setContentType] = useState('markdown'); // 'markdown' or 'react'
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Configure marked options when component mounts
  useEffect(() => {
    configureMarked();
  }, []);

  // Load Babel for React component compilation
  useEffect(() => {
    if (contentType === 'react' && typeof window.Babel === 'undefined') {
      const script = document.createElement('script');
      script.src = 'https://unpkg.com/@babel/standalone/babel.min.js';
      script.async = true;
      document.head.appendChild(script);
    }
  }, [contentType]);

  useEffect(() => {
    const loadPageContent = async () => {
      try {
        setLoading(true);

        // Use the API service to fetch page content
        const pageData = await fetchPageContent(pageId, { language: currentLanguage });

        setPageTitle(pageData.title || '');
        setPageContent(pageData.content || '');

        // Determine content type from the response or infer from content
        if (pageData.contentType) {
          setContentType(pageData.contentType);
        } else {
          // Auto-detect based on content patterns
          const content = pageData.content || '';
          const hasJSX =
            /import\s.*from|export\s|function\s.*\(|const\s.*=|<[A-Z]|useState|useEffect|React\./.test(
              content
            );
          setContentType(hasJSX ? 'react' : 'markdown');
        }

        setError(null);
      } catch (err) {
        console.error('Error fetching page:', err);

        if (err.isAuthRequired) {
          navigate('/unauthorized');
          return;
        }

        if (err.isAccessDenied) {
          navigate('/forbidden');
          return;
        }

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
  }, [pageId, currentLanguage, navigate]);

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

  const renderContent = () => {
    if (contentType === 'react') {
      return (
        <ReactComponentRenderer
          jsxCode={pageContent}
          componentProps={{
            user: {
              // Provide safe user data to components if needed
              language: currentLanguage
              // Add other safe user properties as needed
            },
            t: t, // Provide translation function
            navigate: navigate // Provide navigation function
          }}
          className="prose prose-sm sm:prose lg:prose-lg mx-auto"
        />
      );
    } else {
      // Default to markdown rendering
      const parsedContent = marked(pageContent || '');
      return (
        <div className="prose prose-sm sm:prose lg:prose-lg mx-auto">
          <div
            className="markdown-content"
            dangerouslySetInnerHTML={{ __html: parsedContent }}
          ></div>
        </div>
      );
    }
  };

  return <div className="container">{renderContent()}</div>;
};

export default UnifiedPage;
