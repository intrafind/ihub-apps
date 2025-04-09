import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { atomDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import LoadingSpinner from '../components/LoadingSpinner';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../utils/localizeContent';

const MarkdownPage = () => {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const navigate = useNavigate();
  const { pageId } = useParams();
  const [pageData, setPageData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchPageContent = async () => {
      try {
        setLoading(true);
        const response = await fetch('/api/pages');
        if (!response.ok) {
          throw new Error('Failed to fetch pages data');
        }
        
        const pagesData = await response.json();
        const page = pagesData.pages[pageId];
        
        if (!page) {
          setError('Page not found');
          setLoading(false);
          return;
        }
        
        setPageData(page);
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

  return (
    <div className="container mx-auto py-8 px-4 max-w-4xl">
      <div className="prose prose-sm sm:prose lg:prose-lg mx-auto">
        <ReactMarkdown
          children={pageContent}
          components={{
            h1: ({node, ...props}) => <h1 className="text-3xl font-bold mb-6" {...props} />,
            h2: ({node, ...props}) => <h2 className="text-2xl font-bold mt-8 mb-4" {...props} />,
            h3: ({node, ...props}) => <h3 className="text-xl font-bold mt-6 mb-3" {...props} />,
            p: ({node, ...props}) => <p className="mb-4" {...props} />,
            ul: ({node, ...props}) => <ul className="list-disc pl-6 mb-4" {...props} />,
            ol: ({node, ...props}) => <ol className="list-decimal pl-6 mb-4" {...props} />,
            li: ({node, ...props}) => <li className="mb-1" {...props} />,
            a: ({node, ...props}) => <a className="text-indigo-600 hover:underline" {...props} />,
            blockquote: ({node, ...props}) => <blockquote className="border-l-4 border-gray-300 pl-4 italic" {...props} />,
            code({node, inline, className, children, ...props}) {
              const match = /language-(\w+)/.exec(className || '')
              return !inline && match ? (
                <SyntaxHighlighter
                  children={String(children).replace(/\n$/, '')}
                  style={atomDark}
                  language={match[1]}
                  PreTag="div"
                  {...props}
                />
              ) : (
                <code className={className} {...props}>
                  {children}
                </code>
              )
            }
          }}
        />
      </div>
    </div>
  );
};

export default MarkdownPage;