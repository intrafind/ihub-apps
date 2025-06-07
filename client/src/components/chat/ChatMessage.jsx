import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { marked } from 'marked';
import { sendMessageFeedback } from '../../api/api';
import MessageVariables from './MessageVariables';
import Icon from '../Icon';
import StreamingMarkdown from './StreamingMarkdown';

const ChatMessage = ({ 
  message, 
  outputFormat = 'markdown', 
  onDelete, 
  onEdit, 
  onResend, 
  editable = true,
  appId,
  chatId,
  modelId,
  compact = false  // New prop to indicate compact mode (for widget or mobile)
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
            aria-label="Copy code"
          >
            <span class="icon-copy-code"></span>
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
      
      // Update button appearance using span content instead of direct SVG
      const iconSpan = button.querySelector('.icon-copy-code');
      if (iconSpan) {
        if (isCopied) {
          button.classList.add('bg-green-600');
          button.classList.remove('bg-gray-700');
        } else {
          button.classList.add('bg-gray-700');
          button.classList.remove('bg-green-600');
        }
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
    
    // Automatically resend the message after editing
    if (onResend && isUser) {
      // Use a slightly longer delay to ensure state updates are processed
      setTimeout(() => {
        // Directly pass the edited content to parent component for resending
        console.log('Resending edited message with content:', editedContent);
        onResend(message.id, editedContent);  // Pass the edited content as a second parameter
      }, 250); // Increased delay to ensure edit is processed first
    }
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
    // For HTML content, check if it contains image tags or file indicators and render them properly
    const hasImageContent = message.content && (
      message.content.includes('<img') || 
      message.content.includes('data:image')
    );
    
    //TODO improve detection of file content
    const hasFileContent = message.content && (
      message.content.includes('📎') && message.content.includes('<div') && message.content.includes('</div>')
    );
    
    const hasHTMLContent = hasImageContent || hasFileContent;

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
      console.log('Rendering loading state for message:', message.content);
      // For loading assistant messages with markdown, still use the StreamingMarkdown component
      if (outputFormat === 'markdown' && !isUser) {
        return (
          <div className="flex flex-col">
            <StreamingMarkdown content={message.content} />
            <div className="flex mt-2">
              <span className="inline-block w-2 h-2 bg-gray-500 rounded-full animate-pulse"></span>
              <span className="ml-1 inline-block w-2 h-2 bg-gray-500 rounded-full animate-pulse" style={{ animationDelay: '0.2s' }}></span>
              <span className="ml-1 inline-block w-2 h-2 bg-gray-500 rounded-full animate-pulse" style={{ animationDelay: '0.4s' }}></span>
            </div>
          </div>
        );
      }
      // For user messages or non-markdown, render as plain text
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
          <Icon name="exclamation-circle" className="mr-1.5 text-red-500 flex-shrink-0" />
          <span className="break-all">{message.content}</span>
        </div>
      );
    }
    
    // If the message contains HTML content with an image tag or file content, render it as HTML
    if (hasHTMLContent && isUser) {
      return (
        <div 
          className="break-words whitespace-normal" 
          dangerouslySetInnerHTML={{ __html: message.content }}
        />
      );
    }
    
    if (outputFormat === 'markdown' && !isUser) {
      console.log('Rendering markdown content:', message.content);
      // Use StreamingMarkdown component for better real-time rendering
      return <StreamingMarkdown content={message.content} />;
    }
    
    return <div className="break-words whitespace-normal" style={{boxSizing: 'content-box', display: 'inline-block'}}>{message.content}</div>;
  };

  return (
    <div 
      className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} chat-widget-message ${isUser ? 'user' : 'assistant'}`}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      <div 
        className={`chat-widget-message-content whitespace-normal ${
          isError ? 'error' : ''
        }`}
      >
        {renderContent()}
        {isUser && hasVariables && <MessageVariables variables={message.variables} />}
      </div>
      
      {/* Combined action icons and feedback buttons in a single row */}
      <div className="mt-1 px-1">
        <div className={`flex items-center gap-${compact ? '1' : '3'} text-xs transition-opacity duration-200 ${
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
                <Icon name="check" size="sm" />
                {!compact && <span>{t('chatMessage.copied')}</span>}
              </>
            ) : (
              <>
                <Icon name="copy" size="sm" />
                {!compact && <span>{t('chatMessage.copy')}</span>}
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
                <Icon name="edit" size="sm" />
                {!compact && <span>{t('common.edit')}</span>}
              </button>
              
              <button 
                onClick={handleResend} 
                className="flex items-center gap-1 hover:text-gray-700 transition-colors duration-150" 
                title={t('chatMessage.resendMessage', 'Resend message')}
              >
                <Icon name="refresh" size="sm" />
                {!compact && <span>{t('chatMessage.resend', 'Resend')}</span>}
              </button>
            </>
          )}
          
          <button 
            onClick={handleDelete} 
            className="flex items-center gap-1 hover:text-red-500 transition-colors duration-150" 
            title={t('chatMessage.deleteMessage', 'Delete message')}
          >
            <Icon name="trash" size="sm" />
            {!compact && <span>{t('common.delete')}</span>}
          </button>
          
          {/* Add feedback buttons for AI responses only */}
          {!isUser && !isError && !message.loading && (
            <>
              {!compact && <div className="mx-2 h-4 border-l border-gray-300"></div>}
              <button
                onClick={() => {
                  setFeedbackRating('positive');
                  handleFeedbackClick('positive');
                }}
                className={`p-1 flex items-center gap-1 ${activeFeedback === 'positive' ? 'text-green-600' : 'text-gray-500 hover:text-green-600'} transition-colors duration-150`}
                title={t('feedback.thumbsUp', 'This response was helpful')}
              >
                <Icon 
                  name="thumbs-up" 
                  size="sm" 
                  solid={activeFeedback === 'positive'}
                  className="flex-shrink-0" 
                />
                {!compact && <span>{t('feedback.helpful', 'Helpful')}</span>}
              </button>
              <button
                onClick={() => {
                  setFeedbackRating('negative');
                  handleFeedbackClick('negative');
                }}
                className={`p-1 flex items-center gap-1 ${activeFeedback === 'negative' ? 'text-red-600' : 'text-gray-500 hover:text-red-600'} transition-colors duration-150`}
                title={t('feedback.thumbsDown', 'This response was not helpful')}
              >
                <Icon 
                  name="thumbs-down" 
                  size="sm" 
                  solid={activeFeedback === 'negative'}
                  className="flex-shrink-0 transform rotate-180" 
                />
                {!compact && <span>{t('feedback.notHelpful', 'Not helpful')}</span>}
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
                <Icon name="check-circle" size="2xl" className="text-green-500 mx-auto mb-2" />
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
                        <div className="animate-spin h-5 w-5 mr-2 flex items-center justify-center">
                          <Icon name="refresh" className="text-white" />
                        </div>
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