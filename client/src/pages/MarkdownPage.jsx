import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../utils/localizeContent';
import { fetchUIConfig } from '../api/api';
import LoadingSpinner from '../components/LoadingSpinner';
import { marked } from 'marked';

const MarkdownPage = () => {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const navigate = useNavigate();
  const { pageId } = useParams();
  const [pageData, setPageData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Configure marked options when component mounts
  useEffect(() => {
    marked.setOptions({
      gfm: true,            // Enable GitHub Flavored Markdown
      breaks: true,         // Add <br> on single line breaks
      headerIds: true,      // Generate IDs for headings
      mangle: false,        // Don't escape autolinked email addresses
      pedantic: false,      // Conform to markdown.pl (compatibility)
      sanitize: false,      // Don't sanitize HTML
      smartLists: true,     // Use smart ordered lists
      smartypants: false,   // Use smart quotes, etc.
      xhtml: false          // Don't close all tags
    });
  }, []);

  useEffect(() => {
    const fetchPageContent = async () => {
      try {
        setLoading(true);
        const uiConfig = await fetchUIConfig();
        
        if (!uiConfig || !uiConfig.pages || !uiConfig.pages[pageId]) {
          setError('Page not found');
          setLoading(false);
          return;
        }
        
        setPageData(uiConfig.pages[pageId]);
        setError(null);
      } catch (err) {
        console.error('Error fetching page:', err);
        setError(`Failed to load page: ${err.message}`);
      } finally {
        setLoading(false);
      }
    };

    fetchPageContent();
  }, [pageId]);

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

  // Get localized title and content
  const pageTitle = getLocalizedContent(pageData?.title, currentLanguage);
  const pageContent = getLocalizedContent(pageData?.content, currentLanguage);
  
  // Parse the markdown content using marked
  const parsedContent = marked(pageContent || '');

  return (
    <div className="container mx-auto py-8 px-4 max-w-4xl">
      <div className="prose prose-sm sm:prose lg:prose-lg mx-auto">
        <div className="markdown-content" 
             dangerouslySetInnerHTML={{ __html: parsedContent }}></div>
      </div>
    </div>
  );
};

export default MarkdownPage;