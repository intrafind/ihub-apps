import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import MarkdownRenderer, { configureMarked } from '../../../shared/components/MarkdownRenderer';
import { sendMessageFeedback } from '../../../api/api';
import StarRating from '../../../shared/components/StarRating';
import MessageVariables from './MessageVariables';
import Icon from '../../../shared/components/Icon';
import StreamingMarkdown from './StreamingMarkdown';
import { htmlToMarkdown, markdownToHtml, isMarkdown } from '../../../utils/markdownUtils';
import './ChatMessage.css';

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
  compact = false, // New prop to indicate compact mode (for widget or mobile)
  onOpenInCanvas,
  onInsert,
  canvasEnabled = false
}) => {
  const { t } = useTranslation();

  // Debug loading state changes
  // useEffect(() => {
  //   if (message.id && message.role === 'assistant') {
  //     console.log(`💬 Message ${message.id} loading state:`, message.loading);
  //   }
  // }, [message.loading, message.id, message.role]);

  const isUser = message.role === 'user';
  const isError = message.error === true;
  const hasVariables = message.variables && Object.keys(message.variables).length > 0;
  const [isEditing, setIsEditing] = useState(false);
  const [editedContent, setEditedContent] = useState(
    typeof message.content === 'string' ? message.content : message.content || ''
  );
  const [showActions, setShowActions] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showFeedbackForm, setShowFeedbackForm] = useState(false);
  const [feedbackText, setFeedbackText] = useState('');
  const [feedbackRating, setFeedbackRating] = useState(0); // 0-5 rating scale
  const [feedbackSubmitted, setFeedbackSubmitted] = useState(false);
  const [submittingFeedback, setSubmittingFeedback] = useState(false);
  const [activeFeedback, setActiveFeedback] = useState(0); // Track active rating (0-5)
  const [showThoughts, setShowThoughts] = useState(false);
  const messageRef = useRef(null); // Ref to scope DOM queries to this specific message
  const [showCopyMenu, setShowCopyMenu] = useState(false);
  const copyMenuRef = useRef(null);

  // Configure marked renderer and copy buttons
  useEffect(() => {
    configureMarked();
  }, []);

  // Close copy menu on outside click
  useEffect(() => {
    const handleClick = e => {
      if (copyMenuRef.current && !copyMenuRef.current.contains(e.target)) {
        setShowCopyMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Post-process the rendered markdown to add target="_blank" to external links
  useEffect(() => {
    if (outputFormat === 'markdown' && !isUser && !isEditing && messageRef.current) {
      // Get all links in this specific message's rendered markdown
      const links = messageRef.current.querySelectorAll('a');
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
            console.error('Error parsing URL:', href, e);
          }
        }
      });
    }
  }, [outputFormat, isUser, isEditing, message.content]);

  const handleCopy = (format = 'text') => {
    const raw = typeof message.content === 'string' ? message.content : message.content || '';
    let html = isMarkdown(raw) ? markdownToHtml(raw) : raw;
    let markdown = isMarkdown(raw) ? raw : htmlToMarkdown(raw);
    const temp = document.createElement('div');
    temp.innerHTML = html;
    const plain = temp.textContent || temp.innerText || '';

    let data;
    switch (format) {
      case 'html':
        data = html;
        break;
      case 'markdown':
        data = markdown;
        break;
      default:
        data = plain;
    }

    const hasClipboardWrite = navigator.clipboard && navigator.clipboard.write;
    let copyPromise;

    if (format === 'html' && hasClipboardWrite) {
      const item = new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([plain], { type: 'text/plain' })
      });
      copyPromise = navigator.clipboard.write([item]);
    } else {
      copyPromise = navigator.clipboard.writeText(data);
    }

    copyPromise
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        setShowCopyMenu(false);
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
    setEditedContent(typeof message.content === 'string' ? message.content : message.content || '');
  };

  const handleResend = (useMaxTokens = false) => {
    if (onResend) {
      onResend(message.id, undefined, useMaxTokens);
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
        onResend(message.id, editedContent); // Pass the edited content as a second parameter
      }, 250); // Increased delay to ensure edit is processed first
    }
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditedContent(typeof message.content === 'string' ? message.content : message.content || '');
  };

  // Handle feedback submission
  const handleFeedbackSubmit = async e => {
    e.preventDefault();

    if (!feedbackRating || feedbackRating <= 0) return;

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
        rating: feedbackRating, // Numeric rating (1-5)
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

  // Handle star rating click
  const handleStarRatingClick = rating => {
    // Set the rating and show the feedback form
    setFeedbackRating(rating);
    setShowFeedbackForm(true);
  };

  // Reset feedback when modal is closed without submission
  const handleCloseModal = () => {
    // Only reset if feedback wasn't submitted
    if (!feedbackSubmitted) {
      setFeedbackRating(0);
    }
    setShowFeedbackForm(false);
  };

  // Render the message content based on the output format
  const renderContent = () => {
    // Ensure content is always a string for rendering
    const contentToRender =
      typeof message.content === 'string' ? message.content : message.content || '';

    // For HTML content, check if it contains image tags or file indicators and render them properly
    const hasImageContent =
      !!message.imageData ||
      (contentToRender &&
        typeof contentToRender === 'string' &&
        (contentToRender.includes('<img') || contentToRender.includes('data:image')));

    const hasFileContent = !!message.fileData;

    const hasHTMLContent = hasImageContent || hasFileContent;

    if (isEditing) {
      return (
        <div className="w-full">
          <textarea
            value={editedContent}
            onChange={e => setEditedContent(e.target.value)}
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
      // console.log('🔄 Rendering loading state for message:', contentToRender);
      // For loading assistant messages with markdown or JSON, use StreamingMarkdown
      if (!isUser && (outputFormat === 'markdown' || outputFormat === 'json')) {
        const mdContent =
          outputFormat === 'json'
            ? `\u0060\u0060\u0060json\n${contentToRender}\n\u0060\u0060\u0060`
            : contentToRender;
        return (
          <div className="flex flex-col">
            <StreamingMarkdown content={mdContent} />
            <div className="flex mt-2">
              <span className="inline-block w-2 h-2 bg-gray-500 rounded-full animate-pulse"></span>
              <span
                className="ml-1 inline-block w-2 h-2 bg-gray-500 rounded-full animate-pulse"
                style={{ animationDelay: '0.2s' }}
              ></span>
              <span
                className="ml-1 inline-block w-2 h-2 bg-gray-500 rounded-full animate-pulse"
                style={{ animationDelay: '0.4s' }}
              ></span>
            </div>
          </div>
        );
      }
      // For user messages or non-markdown, render as plain text
      return (
        <div className="flex items-center">
          <span>{contentToRender}</span>
          <span className="ml-2 inline-block w-2 h-2 bg-gray-500 rounded-full animate-pulse"></span>
          <span
            className="ml-1 inline-block w-2 h-2 bg-gray-500 rounded-full animate-pulse"
            style={{ animationDelay: '0.2s' }}
          ></span>
          <span
            className="ml-1 inline-block w-2 h-2 bg-gray-500 rounded-full animate-pulse"
            style={{ animationDelay: '0.4s' }}
          ></span>
        </div>
      );
    }

    if (isError) {
      return (
        <div className="flex items-center">
          <Icon name="exclamation-circle" className="mr-1.5 text-red-500 flex-shrink-0" />
          <span className="break-all">{contentToRender}</span>
        </div>
      );
    }

    // If the message contains HTML content with an image tag or file content, render it as HTML
    if (hasHTMLContent && isUser) {
      return (
        <div
          className="break-words whitespace-normal"
          dangerouslySetInnerHTML={{ __html: contentToRender }}
        />
      );
    }

    if (!isUser && (outputFormat === 'markdown' || outputFormat === 'json')) {
      let mdContent = contentToRender;
      if (outputFormat === 'json') {
        let jsonString = '';
        try {
          jsonString =
            typeof message.content === 'string'
              ? JSON.stringify(JSON.parse(message.content), null, 2)
              : JSON.stringify(message.content, null, 2);
        } catch (e) {
          jsonString =
            typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
        }
        mdContent = `\u0060\u0060\u0060json\n${jsonString}\n\u0060\u0060\u0060`;
      }
      return <StreamingMarkdown content={mdContent} />;
    }

    return (
      <div
        className="break-words whitespace-normal"
        style={{ boxSizing: 'content-box', display: 'inline-block' }}
      >
        {contentToRender}
      </div>
    );
  };

  return (
    <div
      ref={messageRef}
      className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} chat-widget-message ${isUser ? 'user' : 'assistant'}`}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      <div className={`chat-widget-message-content whitespace-normal ${isError ? 'error' : ''}`}>
        {renderContent()}
        {isUser && hasVariables && <MessageVariables variables={message.variables} />}
        {!isUser && message.thoughts && message.thoughts.length > 0 && (
          <div className="mt-1 text-xs text-gray-600">
            <button onClick={() => setShowThoughts(!showThoughts)} className="underline">
              {showThoughts ? t('pages.appChat.hideThoughts') : t('pages.appChat.showThoughts')}
            </button>
            {showThoughts && (
              <ul className="list-disc pl-4 mt-1 space-y-1">
                {message.thoughts.map((th, idx) => (
                  <li key={idx}>{typeof th === 'string' ? th : JSON.stringify(th)}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Info about finish reason and retry options */}
      {!isUser && !isError && !message.loading && message.finishReason && (
        <div className="flex items-center gap-2 text-xs text-gray-600 mb-1">
          {message.finishReason === 'length' && (
            <>
              <Icon name="information-circle" size="sm" className="text-blue-500" />
              <button onClick={() => handleResend(true)} className="underline">
                {t('chatMessage.retryMoreTokens', 'Retry with more tokens')}
              </button>
            </>
          )}
          {(message.finishReason === 'connection_closed' || message.finishReason === 'error') && (
            <>
              <Icon name="exclamation-circle" size="sm" className="text-red-500" />
              <button onClick={() => handleResend()} className="underline text-red-600">
                {t('common.retry', 'Retry')}
              </button>
            </>
          )}
        </div>
      )}

      {/* Combined action icons and feedback buttons in a single row */}
      <div className="mt-1 px-1">
        <div
          className={`flex items-center gap-${compact ? '1' : '3'} text-xs transition-opacity duration-200 ${
            showActions ? 'opacity-100' : 'opacity-0'
          } ${isUser ? 'text-gray-500' : 'text-gray-500'}`}
        >
          {/* Standard actions first */}
          <div className="relative inline-flex items-center" ref={copyMenuRef}>
            <button
              onClick={() => handleCopy('text')}
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
            <button
              onClick={() => setShowCopyMenu(!showCopyMenu)}
              className="ml-1 hover:text-gray-700"
              title={t('canvas.export.copyOptions', 'Copy Options')}
            >
              <Icon name="chevron-down" size="sm" />
            </button>
            {showCopyMenu && (
              <div className="absolute right-0 mt-1 bg-white border border-gray-200 rounded shadow z-10 text-gray-700">
                <button
                  onClick={() => handleCopy('text')}
                  className="block px-3 py-1 text-sm hover:bg-gray-100 w-full text-left whitespace-nowrap"
                >
                  {t('canvas.export.copyText', 'as Text')}
                </button>
                <button
                  onClick={() => handleCopy('markdown')}
                  className="block px-3 py-1 text-sm hover:bg-gray-100 w-full text-left whitespace-nowrap"
                >
                  {t('canvas.export.copyMarkdown', 'as Markdown')}
                </button>
                <button
                  onClick={() => handleCopy('html')}
                  className="block px-3 py-1 text-sm hover:bg-gray-100 w-full text-left whitespace-nowrap"
                >
                  {t('canvas.export.copyHTML', 'as HTML')}
                </button>
              </div>
            )}
          </div>

          {/* Open in Canvas button for assistant messages */}
          {!isUser && !isError && canvasEnabled && onOpenInCanvas && (
            <button
              onClick={() => onOpenInCanvas(message.content)}
              className="flex items-center gap-1 hover:text-blue-600 transition-colors duration-150"
              title={t('chatMessage.openInCanvas', 'Open in Canvas')}
            >
              <Icon name="document-text" size="sm" />
              {!compact && <span>{t('chatMessage.openInCanvas', 'Canvas')}</span>}
            </button>
          )}

          {!isUser && !isError && canvasEnabled && onInsert && (
            <button
              onClick={() => onInsert(message.content)}
              className="flex items-center gap-1 hover:text-blue-600 transition-colors duration-150"
              title={t('canvas.insertIntoDocument', 'Insert into document')}
            >
              <Icon name="arrow-right" size="sm" />
              {!compact && <span>{t('canvas.insert', 'Insert')}</span>}
            </button>
          )}

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

          {/* Add star rating for AI responses only */}
          {!isUser && !isError && !message.loading && (
            <>
              {!compact && <div className="mx-2 h-4 border-l border-gray-300"></div>}
              <div className="flex items-center gap-2">
                <StarRating
                  rating={activeFeedback}
                  onRatingChange={handleStarRatingClick}
                  allowHalfStars={true}
                  size="w-4 h-4"
                  showTooltip={true}
                  className="flex-shrink-0"
                />
                {!compact && activeFeedback > 0 && (
                  <span className="text-sm text-gray-600">{t('feedback.rated', 'Rated')}</span>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Feedback form modal */}
      {showFeedbackForm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-lg max-w-md w-full p-6 animate-fade-in mx-4">
            <h3 className="text-lg font-medium mb-4">
              {t('feedback.ratingHeading', 'Rate this response')}
            </h3>

            {/* Star rating display in modal */}
            <div className="flex items-center justify-center mb-4">
              <StarRating
                rating={feedbackRating}
                onRatingChange={setFeedbackRating}
                allowHalfStars={true}
                size="w-8 h-8"
                showTooltip={true}
                readonly={feedbackSubmitted}
              />
            </div>

            {feedbackSubmitted ? (
              <div className="text-center py-4">
                <Icon name="check-circle" size="2xl" className="text-green-500 mx-auto mb-2" />
                <p>{t('feedback.thankYou', 'Thank you for your feedback!')}</p>
              </div>
            ) : (
              <form onSubmit={handleFeedbackSubmit}>
                <textarea
                  value={feedbackText}
                  onChange={e => setFeedbackText(e.target.value)}
                  className="w-full p-3 border rounded-lg focus:ring-indigo-500 focus:border-indigo-500 mb-4"
                  rows={4}
                  placeholder={t(
                    'feedback.commentPlaceholder',
                    'Tell us more about your rating (optional)'
                  )}
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
