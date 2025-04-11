import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { marked } from 'marked';
import { sendMessageFeedback } from '../api/api';

const ChatMessage = ({ 
  message, 
  outputFormat = 'markdown', 
  onDelete, 
  onEdit, 
  onResend, 
  editable = true,
  appId,
  chatId,
  modelId
}) => {
  const { t } = useTranslation();
  const isUser = message.role === 'user';
  const isError = message.error === true;
  const hasVariables = message.variables && Object.keys(message.variables).length > 0;
  const [isEditing, setIsEditing] = useState(false);
  const [editedContent, setEditedContent] = useState(message.content);
  const [showActions, setShowActions] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedCodeBlockId, setCopiedCodeBlockId] = useState(null);
  const [showFeedbackForm, setShowFeedbackForm] = useState(false);
  const [feedbackText, setFeedbackText] = useState('');
  const [feedbackRating, setFeedbackRating] = useState(null);
  const [feedbackSubmitted, setFeedbackSubmitted] = useState(false);
  const [submittingFeedback, setSubmittingFeedback] = useState(false);
  const [activeFeedback, setActiveFeedback] = useState(null); // Track active feedback button

  // Configure marked options to properly handle tables and customize code blocks
  useEffect(() => {
    // Create a custom renderer to add copy buttons to code blocks
    const renderer = new marked.Renderer();
    
    // Store the original code renderer
    const originalCodeRenderer = renderer.code;
    
    // Override the code method to add copy buttons
    renderer.code = function(code, language, isEscaped) {
      // Generate a unique ID for this code block
      const codeBlockId = `code-block-${Math.random().toString(36).substring(2, 15)}`;
      
      // Get the original HTML from the default renderer
      const originalHtml = originalCodeRenderer.call(this, code, language, isEscaped);
      
      // Add the dark theme classes to the code block
      const enhancedHtml = originalHtml.replace(
        '<pre>',
        '<pre class="bg-gray-800 text-gray-100 rounded-md p-4">'
      );
      
      // Wrap it with a container that includes a copy button
      return `
        <div class="code-block-container relative group">
          ${enhancedHtml}
          <button 
            class="code-copy-btn absolute top-2 right-2 p-1 rounded text-xs bg-gray-700 text-white opacity-0 group-hover:opacity-100 transition-opacity duration-200"
            data-code-id="${codeBlockId}"
            data-code-content="${encodeURIComponent(code)}"
            type="button"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"></path>
            </svg>
          </button>
        </div>
      `;
    };

    marked.setOptions({
      gfm: true,            // Enable GitHub Flavored Markdown
      breaks: true,         // Add <br> on single line breaks
      headerIds: true,      // Generate IDs for headings
      mangle: false,        // Don't escape autolinked email addresses
      pedantic: false,      // Conform to markdown.pl (compatibility)
      sanitize: false,      // Don't sanitize HTML
      smartLists: true,     // Use smart ordered lists
      smartypants: false,   // Use smart quotes, etc.
      xhtml: false,         // Don't close all tags
      highlight: function(code, lang) {
        // Re-add syntax highlighting
        if (lang && window.hljs && window.hljs.getLanguage(lang)) {
          try {
            return window.hljs.highlight(code, { language: lang }).value;
          } catch (e) {
            console.error("Highlighting error:", e);
          }
        }
        return code; // Use default highlighting
      },
      renderer: renderer    // Use our custom renderer
    });
  }, []);

  // Add event listener for the copy code buttons after rendering markdown
  useEffect(() => {
    if (outputFormat === 'markdown' && !isUser && !isEditing) {
      const handleCodeCopyClick = (e) => {
        // Check if the click was on a copy button or its child elements
        const button = e.target.closest('.code-copy-btn');
        if (!button) return;
        
        // Get the code content from the data attribute
        const codeContent = decodeURIComponent(button.dataset.codeContent);
        const codeId = button.dataset.codeId;
        
        // Copy to clipboard
        navigator.clipboard.writeText(codeContent)
          .then(() => {
            setCopiedCodeBlockId(codeId);
            setTimeout(() => setCopiedCodeBlockId(null), 2000);
            console.log('Code block copied to clipboard');
          })
          .catch(err => {
            console.error('Failed to copy code block: ', err);
          });
      };

      // Add the event listener to the document to catch all code copy buttons
      document.addEventListener('click', handleCodeCopyClick);
      
      // Clean up
      return () => {
        document.removeEventListener('click', handleCodeCopyClick);
      };
    }
  }, [outputFormat, isUser, isEditing]);

  // Style the copy buttons based on the copied state
  useEffect(() => {
    const allButtons = document.querySelectorAll('.code-copy-btn');
    
    allButtons.forEach(button => {
      const isCopied = button.dataset.codeId === copiedCodeBlockId;
      
      // Update button appearance
      if (isCopied) {
        button.innerHTML = `
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
          </svg>
        `;
        button.classList.add('bg-green-600');
        button.classList.remove('bg-gray-700');
      } else {
        button.innerHTML = `
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"></path>
          </svg>
        `;
        button.classList.add('bg-gray-700');
        button.classList.remove('bg-green-600');
      }
    });
  }, [copiedCodeBlockId]);

  // Post-process the rendered markdown to add target="_blank" to external links
  useEffect(() => {
    if (outputFormat === 'markdown' && !isUser && !isEditing) {
      // Get all links in the rendered markdown
      const markdownContainer = document.querySelector('.markdown-content');
      if (!markdownContainer) return;
      
      const links = markdownContainer.querySelectorAll('a');
      const currentDomain = window.location.hostname;
      
      links.forEach(link => {
        const href = link.getAttribute('href');
        
        // Check if the link is external
        if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
          try {
            const url = new URL(href);
            // If the hostname is different from the current domain, open in a new tab
            if (url.hostname !== currentDomain) {
              link.setAttribute('target', '_blank');
              link.setAttribute('rel', 'noopener noreferrer');
            }
          } catch (e) {
            console.error("Error parsing URL:", href, e);
          }
        }
      });
    }
  }, [outputFormat, isUser, isEditing, message.content]);

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

  // Handle feedback submission
  const handleFeedbackSubmit = async (e) => {
    e.preventDefault();
    
    if (!feedbackRating) return;
    
    setSubmittingFeedback(true);
    
    try {
      // Ensure we're using exactly the same message ID that was initially created
      // Use the messageId property if available, otherwise fall back to id
      const exactMessageId = message.messageId || message.id;
      
      console.log(`Submitting feedback with exact messageId: ${exactMessageId}`);
      
      await sendMessageFeedback({
        messageId: exactMessageId,
        appId,
        chatId,
        modelId,
        rating: feedbackRating, // 'positive' or 'negative'
        feedback: feedbackText,
        messageContent: message.content.substring(0, 300) // Send a snippet for context
      });
      
      // Keep the feedback button activated only after successful submission
      setActiveFeedback(feedbackRating);
      
      setFeedbackSubmitted(true);
      setTimeout(() => {
        setShowFeedbackForm(false);
        // Reset after hiding the form
        setTimeout(() => {
          setFeedbackSubmitted(false);
          setFeedbackText('');
        }, 300);
      }, 1500);
    } catch (error) {
      console.error('Error submitting feedback:', error);
      alert(t('error.feedbackSubmission', 'Error submitting feedback. Please try again.'));
    } finally {
      setSubmittingFeedback(false);
    }
  };
  
  // Handle showing feedback form
  const handleFeedbackClick = (rating) => {
    // Only set a temporary rating - don't activate the button yet
    setFeedbackRating(rating);
    setShowFeedbackForm(true);
  };
  
  // Reset feedback when modal is closed without submission
  const handleCloseModal = () => {
    // Only reset if feedback wasn't submitted
    if (!feedbackSubmitted) {
      setFeedbackRating(null);
    }
    setShowFeedbackForm(false);
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
      
      {/* Combined action icons and feedback buttons in a single row */}
      <div className="mt-1 px-1">
        <div className={`flex items-center gap-3 text-xs transition-opacity duration-200 ${
          showActions ? 'opacity-100' : 'opacity-0'
        } ${isUser ? 'text-gray-500' : 'text-gray-500'}`}>
          {/* Standard actions first */}
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
          
          {/* Add feedback buttons for AI responses only */}
          {!isUser && !isError && !message.loading && (
            <>
              <div className="mx-2 h-4 border-l border-gray-300"></div>
              <button
                onClick={() => {
                  setFeedbackRating('positive');
                  handleFeedbackClick('positive');
                }}
                className={`p-1 flex items-center gap-1 ${activeFeedback === 'positive' ? 'text-green-600' : 'text-gray-500 hover:text-green-600'} transition-colors duration-150`}
                title={t('feedback.thumbsUp', 'This response was helpful')}
              >
                <svg className="w-4 h-4" fill={activeFeedback === 'positive' ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905a3.61 3.61 0 01-.608 2.006L7 11v9m7-10h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5" />
                </svg>
                <span>{t('feedback.helpful', 'Helpful')}</span>
              </button>
              <button
                onClick={() => {
                  setFeedbackRating('negative');
                  handleFeedbackClick('negative');
                }}
                className={`p-1 flex items-center gap-1 ${activeFeedback === 'negative' ? 'text-red-600' : 'text-gray-500 hover:text-red-600'} transition-colors duration-150`}
                title={t('feedback.thumbsDown', 'This response was not helpful')}
              >
                {/* Fixed thumbs down icon using transform rotate-180 */}
                <svg className="w-4 h-4 transform rotate-180" fill={activeFeedback === 'negative' ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905a3.61 3.61 0 01-.608 2.006L7 11v9m7-10h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5" />
                </svg>
                <span>{t('feedback.notHelpful', 'Not helpful')}</span>
              </button>
            </>
          )}
        </div>
      </div>
      
      {/* Feedback form modal */}
      {showFeedbackForm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-lg max-w-md w-full p-6 animate-fade-in mx-4">
            <h3 className="text-lg font-medium mb-4">
              {feedbackRating === 'positive' 
                ? t('feedback.positiveHeading', 'What was helpful about this response?')
                : t('feedback.negativeHeading', 'What was unhelpful about this response?')
              }
            </h3>
            
            {feedbackSubmitted ? (
              <div className="text-center py-4">
                <svg className="w-16 h-16 text-green-500 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <p>{t('feedback.thankYou', 'Thank you for your feedback!')}</p>
              </div>
            ) : (
              <form onSubmit={handleFeedbackSubmit}>
                <textarea
                  value={feedbackText}
                  onChange={(e) => setFeedbackText(e.target.value)}
                  className="w-full p-3 border rounded-lg focus:ring-indigo-500 focus:border-indigo-500 mb-4"
                  rows={4}
                  placeholder={t('feedback.placeholder', 'Your feedback helps us improve (optional)')}
                ></textarea>
                
                <div className="flex justify-end gap-3">
                  <button
                    type="button"
                    onClick={handleCloseModal}
                    className="px-4 py-2 bg-gray-200 hover:bg-gray-300 text-gray-800 rounded-lg transition-colors"
                    disabled={submittingFeedback}
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors flex items-center"
                    disabled={submittingFeedback}
                  >
                    {submittingFeedback ? (
                      <>
                        <svg className="animate-spin h-5 w-5 mr-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        {t('feedback.sending', 'Sending...')}
                      </>
                    ) : (
                      t('feedback.sendFeedback', 'Send Feedback')
                    )}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default ChatMessage;