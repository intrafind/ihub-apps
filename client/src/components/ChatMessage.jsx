import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { marked } from 'marked';

const ChatMessage = ({ 
  message, 
  outputFormat = 'markdown', 
  onDelete, 
  onEdit, 
  onResend, 
  editable = true 
}) => {
  const { t } = useTranslation();
  const isUser = message.role === 'user';
  const isError = message.error === true;
  const hasVariables = message.variables && Object.keys(message.variables).length > 0;
  const [isEditing, setIsEditing] = useState(false);
  const [editedContent, setEditedContent] = useState(message.content);
  const [showActions, setShowActions] = useState(false);
  const [copied, setCopied] = useState(false);

  // Configure marked options to properly handle tables 
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

  const handleCopyToClipboard = () => {
    navigator.clipboard.writeText(message.content)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000); // Reset after 2 seconds
        console.log('Content copied to clipboard');
      })
      .catch(err => {
        console.error('Failed to copy content: ', err);
      });
  };

  const handleDelete = () => {
    if (onDelete) {
      onDelete(message.id);
    }
  };

  const handleEdit = () => {
    setIsEditing(true);
    setEditedContent(message.content);
  };

  const handleResend = () => {
    if (onResend) {
      onResend(message.id);
    }
  };

  const handleSaveEdit = () => {
    if (onEdit) {
      onEdit(message.id, editedContent);
    }
    setIsEditing(false);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditedContent(message.content);
  };
  
  // Render the message content based on the output format
  const renderContent = () => {
    if (isEditing) {
      return (
        <div className="w-full">
          <textarea
            value={editedContent}
            onChange={(e) => setEditedContent(e.target.value)}
            className="w-full p-2 border rounded mb-2 text-gray-800 bg-white"
            rows={Math.max(3, editedContent.split('\n').length)}
          />
          <div className="flex space-x-2 justify-end">
            <button 
              onClick={handleCancelEdit}
              className="px-2 py-1 text-xs bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
            >
              {t('common.cancel')}
            </button>
            <button 
              onClick={handleSaveEdit}
              className="px-2 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700"
            >
              {t('common.save')}
            </button>
          </div>
        </div>
      );
    }

    if (message.loading) {
      return (
        <div className="flex items-center">
          <span>{message.content}</span>
          <span className="ml-2 inline-block w-2 h-2 bg-gray-500 rounded-full animate-pulse"></span>
          <span className="ml-1 inline-block w-2 h-2 bg-gray-500 rounded-full animate-pulse" style={{ animationDelay: '0.2s' }}></span>
          <span className="ml-1 inline-block w-2 h-2 bg-gray-500 rounded-full animate-pulse" style={{ animationDelay: '0.4s' }}></span>
        </div>
      );
    }
    
    if (isError) {
      return (
        <div className="flex items-center">
          <svg className="w-5 h-5 mr-1.5 text-red-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>{message.content}</span>
        </div>
      );
    }
    
    if (outputFormat === 'markdown' && !isUser) {
      // Use marked to parse markdown including tables
      const parsedContent = marked(message.content);
      
      return (
        <div className="markdown-content" 
             dangerouslySetInnerHTML={{ __html: parsedContent }}></div>
      );
    }
    
    return <div>{message.content}</div>;
  };

  // Render variables if they exist (like target language)
  const renderVariables = () => {
    if (!hasVariables) return null;
    
    return (
      <div className="mt-2 pt-2 border-t border-gray-200 dark:border-gray-700">
        <div className="text-xs text-gray-500 dark:text-gray-400">
          {Object.entries(message.variables).map(([key, value]) => (
            <div key={key} className="inline-block mr-3">
              <span className="font-medium">{key}:</span> {value}
            </div>
          ))}
        </div>
      </div>
    );
  };

  // Render message actions
  const renderActions = () => {
    if (message.loading) return null;
    
    return (
      <div className={`flex justify-end items-center gap-3 text-xs transition-opacity duration-200 ${
        showActions ? 'opacity-100' : 'opacity-0'
      } ${isUser ? 'text-gray-500' : 'text-gray-500'}`}>
        <button
          onClick={handleCopyToClipboard}
          className="flex items-center gap-1 hover:text-gray-700 transition-colors duration-150"
          title={t('pages.appChat.copyToClipboard')}
        >
          {copied ? (
            <>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <span>{t('chatMessage.copied')}</span>
            </>
          ) : (
            <>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
              </svg>
              <span>{t('chatMessage.copy')}</span>
            </>
          )}
        </button>
        
        {isUser && editable && (
          <>
            <button 
              onClick={handleEdit} 
              className="flex items-center gap-1 hover:text-gray-700 transition-colors duration-150" 
              title={t('chatMessage.editMessage', 'Edit message')}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
              </svg>
              <span>{t('common.edit')}</span>
            </button>
            
            <button 
              onClick={handleResend} 
              className="flex items-center gap-1 hover:text-gray-700 transition-colors duration-150" 
              title={t('chatMessage.resendMessage', 'Resend message')}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <span>{t('chatMessage.resend', 'Resend')}</span>
            </button>
          </>
        )}
        
        <button 
          onClick={handleDelete} 
          className="flex items-center gap-1 hover:text-red-500 transition-colors duration-150" 
          title={t('chatMessage.deleteMessage', 'Delete message')}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
          <span>{t('common.delete')}</span>
        </button>
      </div>
    );
  };

  return (
    <div 
      className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      <div 
        className={`relative max-w-4xl rounded-lg px-4 py-3 ${
          isUser 
            ? 'bg-indigo-600 text-white' 
            : isError
              ? 'bg-red-50 border border-red-200 text-red-700'
              : 'bg-white border border-gray-200 text-gray-800'
        }`}
      >
        {renderContent()}
        {isUser && hasVariables && renderVariables()}
      </div>
      
      {/* Action icons row below the message */}
      <div className="mt-1 px-1">
        {renderActions()}
      </div>
    </div>
  );
};

export default ChatMessage;