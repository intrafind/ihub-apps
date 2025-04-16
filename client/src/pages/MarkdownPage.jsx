import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import LoadingSpinner from '../components/LoadingSpinner';
import { marked } from 'marked';

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
        
        // Use the new API endpoint to fetch page content
        const response = await fetch(`/api/pages/${pageId}?lang=${currentLanguage}`);
        
        if (!response.ok) {
          if (response.status === 404) {
            setError('Page not found');
          } else {
            throw new Error(`Failed to load page: ${response.status} ${response.statusText}`);
          }
          setLoading(false);
          return;
        }
        
        const pageData = await response.json();
        setPageTitle(pageData.title || '');
        setMarkdownContent(pageData.content || '');
        setError(null);
      } catch (err) {
        console.error('Error fetching page:', err);
        setError(`Failed to load page: ${err.message}`);
      } finally {
        setLoading(false);
      }
    };

    fetchPageContent();
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
      <div className="prose prose-sm sm:prose lg:prose-lg mx-auto">
        <div className="markdown-content" 
             dangerouslySetInnerHTML={{ __html: parsedContent }}></div>
      </div>
    </div>
  );
};

export default MarkdownPage;