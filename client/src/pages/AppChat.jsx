import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { fetchAppDetails, fetchModels, fetchStyles, sendAppChatMessage, stopAppChatStream, checkAppChatStatus, isTimeoutError } from '../api/api';
import ChatMessage from '../components/ChatMessage';
import AppConfigForm from '../components/AppConfigForm';
import LoadingSpinner from '../components/LoadingSpinner';
import { useHeaderColor } from '../components/HeaderColorContext';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../utils/localizeContent';

const AppChat = () => {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const { appId } = useParams();
  const navigate = useNavigate();
  const [app, setApp] = useState(null);
  const [models, setModels] = useState([]);
  const [styles, setStyles] = useState({});
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState(null);
  const [showConfig, setShowConfig] = useState(false);
  const [selectedModel, setSelectedModel] = useState(null);
  const [selectedStyle, setSelectedStyle] = useState('normal');
  const [selectedOutputFormat, setSelectedOutputFormat] = useState('markdown');
  const [sendChatHistory, setSendChatHistory] = useState(true);
  const [temperature, setTemperature] = useState(0.7);
  const [variables, setVariables] = useState({});
  const [showParameters, setShowParameters] = useState(true);
  const { setHeaderColor } = useHeaderColor();
  const [translationsLoaded, setTranslationsLoaded] = useState(false);

  const chatContainerRef = useRef(null);
  const chatId = useRef(`chat-${Date.now()}`);
  const eventSourceRef = useRef(null);
  const connectionTimeoutRef = useRef(null);
  const heartbeatIntervalRef = useRef(null);

  // Effect to handle translation loading completeness
  useEffect(() => {
    // Subscribe to i18next's "loaded" event
    const handleTranslationsLoaded = (loaded) => {
      if (loaded) {
        // Force a re-render when translations are fully loaded
        setTranslationsLoaded(true);
        setTimeout(() => setTranslationsLoaded(false), 100);
      }
    };

    i18n.on('loaded', handleTranslationsLoaded);
    
    return () => {
      i18n.off('loaded', handleTranslationsLoaded);
    };
  }, [i18n]);

  const hasVariablesToSend = app?.variables && Object.keys(variables).length > 0;

  // Enhanced cleanup function to properly handle all resources
  const cleanupEventSource = useCallback(() => {
    if (eventSourceRef.current) {
      try {
        // Stop any running heartbeat checks
        if (heartbeatIntervalRef.current) {
          clearInterval(heartbeatIntervalRef.current);
          heartbeatIntervalRef.current = null;
        }

        // Clear any pending connection timeouts
        if (connectionTimeoutRef.current) {
          clearTimeout(connectionTimeoutRef.current);
          connectionTimeoutRef.current = null;
        }

        // Tell the server to stop processing this chat session
        if (appId && chatId.current) {
          stopAppChatStream(appId, chatId.current).catch((err) =>
            console.warn('Failed to stop chat stream:', err)
          );
        }

        // Close the event source connection
        const eventSource = eventSourceRef.current;
        eventSourceRef.current = null; // Set to null first to prevent potential recursion issues

        // Remove all event listeners to prevent memory leaks
        eventSource.removeEventListener('connected', eventSource.onconnected);
        eventSource.removeEventListener('chunk', eventSource.onchunk);
        eventSource.removeEventListener('done', eventSource.ondone);
        eventSource.removeEventListener('error', eventSource.onerror);

        // Finally close the connection
        eventSource.close();

        console.log('Successfully cleaned up event source for chat:', chatId.current);
      } catch (err) {
        console.error('Error cleaning up event source:', err);
      }
    }
  }, [appId]);

  // Start a heartbeat check to ensure server connection is still alive
  const startHeartbeat = useCallback(() => {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
    }

    heartbeatIntervalRef.current = setInterval(async () => {
      if (!eventSourceRef.current || !appId || !chatId.current) {
        return;
      }

      try {
        const status = await checkAppChatStatus(appId, chatId.current);
        if (!status || !status.active) {
          console.warn('Chat session no longer active on server, cleaning up');
          cleanupEventSource();
          setProcessing(false);
        }
      } catch (error) {
        console.warn('Error checking chat status:', error);
        // Don't cleanup on error check - it might be a temporary network issue
      }
    }, 30000); // Check every 30 seconds

    return () => {
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }
    };
  }, [appId, cleanupEventSource]);

  // Cleanup on component unmount
  useEffect(() => {
    return () => {
      cleanupEventSource();

      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }

      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }
    };
  }, [cleanupEventSource]);

  useEffect(() => {
    const loadData = async () => {
      try {
        setLoading(true);

        const appData = await fetchAppDetails(appId);
        setApp(appData);

        if (appData?.color) {
          setHeaderColor(appData.color);
        }

        setTemperature(appData.preferredTemperature || 0.7);
        setSelectedStyle(appData.preferredStyle || 'normal');
        setSelectedOutputFormat(appData.preferredOutputFormat || 'markdown');
        setSendChatHistory(appData.sendChatHistory !== undefined ? appData.sendChatHistory : true);

        if (appData.variables) {
          const initialVars = {};
          appData.variables.forEach((variable) => {
            // For select variables with predefined values, ensure we store the value, not the label
            if (variable.predefinedValues && variable.defaultValue) {
              // If defaultValue is an object with language keys
              if (typeof variable.defaultValue === 'object') {
                const localizedLabel = getLocalizedContent(variable.defaultValue, i18n.language);
                // Find the matching value for the localized label
                const matchingOption = variable.predefinedValues.find(
                  option => getLocalizedContent(option.label, i18n.language) === localizedLabel
                );
                // Use the value from predefined values if found, otherwise use the localized label
                initialVars[variable.name] = matchingOption ? matchingOption.value : localizedLabel;
              } else {
                // If defaultValue is a direct string, use it as is
                initialVars[variable.name] = variable.defaultValue;
              }
            } else {
              // For other variables, use standard localization
              const localizedDefaultValue =
                typeof variable.defaultValue === 'object'
                  ? getLocalizedContent(variable.defaultValue, i18n.language)
                  : variable.defaultValue || '';
              initialVars[variable.name] = localizedDefaultValue;
            }
          });
          setVariables(initialVars);
        }

        const modelsData = await fetchModels();
        setModels(modelsData);

        let modelToSelect = appData.preferredModel;
        if (appData.allowedModels && appData.allowedModels.length > 0) {
          if (!appData.allowedModels.includes(appData.preferredModel)) {
            modelToSelect = appData.allowedModels[0];
          }
        }

        setSelectedModel(modelToSelect);

        const stylesData = await fetchStyles();
        setStyles(stylesData);

        setError(null);
      } catch (err) {
        console.error('Error loading app data:', err);
        setError(
          t('error.failedToLoadApp', 'Failed to load application data. Please try again later.')
        );
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, [appId, setHeaderColor, i18n.language, t]);

  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [messages]);

  const handleInputChange = (e) => {
    setInput(e.target.value);
  };

  const handleDeleteMessage = (messageId) => {
    setMessages((prev) => prev.filter((message) => message.id !== messageId));
  };

  const handleEditMessage = (messageId, newContent) => {
    const messageToEdit = messages.find((msg) => msg.id === messageId);
    if (!messageToEdit) return;

    const messageIndex = messages.findIndex((msg) => msg.id === messageId);
    const previousMessages = messages.slice(0, messageIndex + 1);

    setMessages(
      previousMessages.map((message) =>
        message.id === messageId ? { ...message, content: newContent } : message
      )
    );

    if (messageToEdit.role === 'user') {
      (async () => {
        try {
          cleanupEventSource();

          setProcessing(true);
          setError(null);

          const currentMessages = previousMessages.map((message) =>
            message.id === messageId ? { ...message, content: newContent } : message
          );

          const messageForAPI = {
            role: 'user',
            content: newContent,
            promptTemplate: app?.prompt || null,
            variables: { ...variables },
          };

          const messagesForAPI =
            sendChatHistory === false
              ? [messageForAPI]
              : currentMessages.map((msg) => {
                  const { id, loading, error, ...apiMsg } = msg;
                  return apiMsg;
                });

          const assistantMessageId = Date.now();
          setMessages((prev) => [
            ...prev,
            {
              id: assistantMessageId,
              role: 'assistant',
              content: '',
              loading: true,
            },
          ]);

          const eventSource = new EventSource(
            `/api/apps/${appId}/chat/${chatId.current}`
          );
          eventSourceRef.current = eventSource;

          let fullContent = '';
          let connectionEstablished = false;

          connectionTimeoutRef.current = setTimeout(() => {
            if (!connectionEstablished) {
              console.error('SSE connection timeout');
              eventSource.close();

              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === assistantMessageId
                    ? {
                        ...msg,
                        content: t('error.connectionTimeout', 'Connection timeout. Please try again.'),
                        loading: false,
                        error: true,
                      }
                    : msg
                )
              );

              setProcessing(false);
            }
          }, 10000);

          eventSource.addEventListener('connected', async () => {
            connectionEstablished = true;
            clearTimeout(connectionTimeoutRef.current);

            try {
              // Log the parameters being sent to the server for debugging
              const requestParams = {
                modelId: selectedModel,
                style: selectedStyle,
                temperature,
                outputFormat: selectedOutputFormat,
                language: currentLanguage,
              };
              console.log('Sending chat message with parameters:', requestParams);
              
              await sendAppChatMessage(appId, chatId.current, messagesForAPI, requestParams);
            } catch (postError) {
              console.error('Error sending chat message:', postError);

              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === assistantMessageId
                    ? {
                        ...msg,
                        content: t(
                          'error.failedToGenerateResponse',
                          'Error: Failed to generate response. Please try again or select a different model.'
                        ),
                        loading: false,
                        error: true,
                      }
                    : msg
                )
              );

              eventSource.close();
              eventSourceRef.current = null;
              setProcessing(false);
            }
          });

          eventSource.addEventListener('chunk', (event) => {
            try {
              const data = JSON.parse(event.data);
              fullContent += data.content || '';

              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === assistantMessageId
                    ? { ...msg, content: fullContent, loading: true }
                    : msg
                )
              );
            } catch (error) {
              console.error('Error processing chunk:', error);
            }
          });

          eventSource.addEventListener('done', () => {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === assistantMessageId ? { ...msg, loading: false } : msg
              )
            );

            eventSource.close();
            eventSourceRef.current = null;
            setProcessing(false);
          });

          eventSource.addEventListener('error', (event) => {
            console.error('SSE Error:', event);

            let errorMessage = t(
              'error.responseError',
              'Error receiving response. Please try again.'
            );

            try {
              if (event.data) {
                const errorData = JSON.parse(event.data);
                if (errorData.message) {
                  if (errorData.message.includes('API key not found')) {
                    errorMessage = `${errorData.message}. ${t(
                      'error.checkApiConfig',
                      'Please check your API configuration.'
                    )}`;
                  } else {
                    errorMessage = errorData.message;
                  }
                }
              }
            } catch (e) {}

            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === assistantMessageId
                  ? {
                      ...msg,
                      content: `Error: ${errorMessage}`,
                      loading: false,
                      error: true,
                    }
                  : msg
              )
            );

            eventSource.close();
            eventSourceRef.current = null;
            setProcessing(false);
          });

          startHeartbeat();
        } catch (err) {
          console.error('Error sending message:', err);

          setMessages((prev) => [
            ...prev,
            {
              id: Date.now(),
              role: 'system',
              content: `Error: ${t(
                'error.sendMessageFailed',
                'Failed to send message.'
              )} ${
                err.message || t('error.tryAgain', 'Please try again.')
              }`,
              error: true,
            },
          ]);

          setProcessing(false);
        }
      })();
    }
  };

  const handleResendMessage = (messageId) => {
    const messageToResend = messages.find((msg) => msg.id === messageId);
    if (!messageToResend) return;

    setInput(messageToResend.content);

    setTimeout(() => {
      const form = document.querySelector('form');
      if (form) {
        const submitEvent = new Event('submit', { cancelable: true, bubbles: true });
        form.dispatchEvent(submitEvent);
      }
    }, 0);
  };

  const clearChat = () => {
    if (
      window.confirm(
        t(
          'pages.appChat.confirmClear',
          'Are you sure you want to clear the entire chat history?'
        )
      )
    ) {
      cleanupEventSource();

      setMessages([]);
      chatId.current = `chat-${Date.now()}`;
    }
  };

  const cancelGeneration = useCallback(() => {
    cleanupEventSource();

    setMessages((prev) => {
      const lastMessageIndex = prev.length - 1;
      if (lastMessageIndex >= 0 && prev[lastMessageIndex].loading) {
        const updatedMessages = [...prev];
        updatedMessages[lastMessageIndex] = {
          ...updatedMessages[lastMessageIndex],
          content:
            updatedMessages[lastMessageIndex].content +
            t('message.generationCancelled', ' [Generation cancelled]'),
          loading: false,
        };
        return updatedMessages;
      }
      return prev;
    });

    setProcessing(false);
  }, [cleanupEventSource, t]);

  const handleSubmit = async (e) => {
    e.preventDefault();

    // Ensure input isn't empty before proceeding
    if (!input.trim()) {
      return;
    }

    // Check for required variables
    if (app?.variables) {
      const missingRequiredVars = app.variables
        .filter((v) => v.required)
        .filter((v) => !variables[v.name] || variables[v.name].trim() === '');

      if (missingRequiredVars.length > 0) {
        // Show inline error instead of using setError
        const errorMessage = t(
          'error.missingRequiredFields',
          'Please fill in all required fields:'
        ) + ' ' + missingRequiredVars.map((v) => getLocalizedContent(v.label, currentLanguage)).join(', ');
        
        setMessages(prev => [...prev, {
          id: Date.now(),
          role: 'system',
          content: errorMessage,
          error: true,
          isErrorMessage: true
        }]);
        
        // Highlight missing fields by scrolling to parameters section on mobile
        if (window.innerWidth < 768 && !showParameters) {
          toggleParameters();
        }
        
        return;
      }
    }

    // Clear any error message when proceeding
    setError(null);

    try {
      cleanupEventSource();

      setProcessing(true);

      const originalUserInput = input;

      const userMessageId = Date.now();
      const newUserMessage = {
        id: userMessageId,
        role: 'user',
        content: originalUserInput,
        variables:
          app?.variables && app.variables.length > 0
            ? { ...variables }
            : undefined,
      };

      setMessages((prev) => [...prev, newUserMessage]);
      setInput('');

      const messageForAPI = {
        role: 'user',
        content: originalUserInput,
        promptTemplate: app?.prompt || null,
        variables: { ...variables },
      };

      const messagesForAPI =
        sendChatHistory === false
          ? [messageForAPI]
          : messages.concat(messageForAPI).map((msg) => {
              const { id, loading, error, ...apiMsg } = msg;
              return apiMsg;
            });

      const assistantMessageId = userMessageId + 1;
      setMessages((prev) => [
        ...prev,
        {
          id: assistantMessageId,
          role: 'assistant',
          content: '',
          loading: true,
        },
      ]);

      const eventSource = new EventSource(
        `/api/apps/${appId}/chat/${chatId.current}`
      );
      eventSourceRef.current = eventSource;

      let fullContent = '';
      let connectionEstablished = false;

      connectionTimeoutRef.current = setTimeout(() => {
        if (!connectionEstablished) {
          console.error('SSE connection timeout');
          eventSource.close();

          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMessageId
                ? {
                    ...msg,
                    content: t('error.connectionTimeout', 'Connection timeout. Please try again.'),
                    loading: false,
                    error: true,
                  }
                : msg
            )
          );

          setProcessing(false);
        }
      }, 10000);

      eventSource.addEventListener('connected', async () => {
        connectionEstablished = true;
        clearTimeout(connectionTimeoutRef.current);

        try {
          // Log the parameters being sent to the server for debugging
          const requestParams = {
            modelId: selectedModel,
            style: selectedStyle,
            temperature,
            outputFormat: selectedOutputFormat,
            language: currentLanguage,
          };
          console.log('Sending chat message with parameters:', requestParams);
          
          await sendAppChatMessage(appId, chatId.current, messagesForAPI, requestParams);
        } catch (postError) {
          console.error('Error sending chat message:', postError);

          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMessageId
                ? {
                    ...msg,
                    content: t(
                      'error.failedToGenerateResponse',
                      'Error: Failed to generate response. Please try again or select a different model.'
                    ),
                    loading: false,
                    error: true,
                  }
                : msg
            )
          );

          eventSource.close();
          eventSourceRef.current = null;
          setProcessing(false);
        }
      });

      eventSource.addEventListener('chunk', (event) => {
        try {
          const data = JSON.parse(event.data);
          fullContent += data.content || '';

          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMessageId
                ? { ...msg, content: fullContent, loading: true }
                : msg
            )
          );
        } catch (error) {
          console.error('Error processing chunk:', error);
        }
      });

      eventSource.addEventListener('done', () => {
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMessageId ? { ...msg, loading: false } : msg
          )
        );

        eventSource.close();
        eventSourceRef.current = null;
        setProcessing(false);
      });

      eventSource.addEventListener('error', (event) => {
        console.error('SSE Error:', event);
        clearTimeout(connectionTimeoutRef.current);

        let errorMessage = t(
          'error.responseError',
          'Error receiving response. Please try again.'
        );

        try {
          if (event.data) {
            const errorData = JSON.parse(event.data);
            if (errorData.message) {
              if (errorData.message.includes('API key not found')) {
                errorMessage = `${errorData.message}. ${t(
                  'error.checkApiConfig',
                  'Please check your API configuration.'
                )}`;
              } else {
                errorMessage = errorData.message;
              }
            }
          }
        } catch (e) {}

        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMessageId
              ? {
                  ...msg,
                  content: `Error: ${errorMessage}`,
                  loading: false,
                  error: true,
                }
              : msg
          )
        );

        eventSource.close();
        eventSourceRef.current = null;
        setProcessing(false);
      });

      startHeartbeat();
    } catch (err) {
      console.error('Error sending message:', err);

      setMessages((prev) => [
        ...prev,
        {
          id: Date.now(),
          role: 'system',
          content: `Error: ${t(
            'error.sendMessageFailed',
            'Failed to send message.'
          )} ${
            err.message || t('error.tryAgain', 'Please try again.')
          }`,
          error: true,
        },
      ]);

      setProcessing(false);
    }
  };

  const toggleConfig = () => {
    setShowConfig(!showConfig);
  };

  const toggleParameters = () => {
    setShowParameters(!showParameters);
  };

  const localizeVariables = (variables) => {
    if (!variables || !Array.isArray(variables)) return [];

    return variables.map((variable) => ({
      ...variable,
      localizedLabel: getLocalizedContent(variable.label, currentLanguage) || variable.name,
      localizedDescription: getLocalizedContent(
        variable.description,
        currentLanguage
      ),
      localizedDefaultValue: getLocalizedContent(
        variable.defaultValue,
        currentLanguage
      ),
      predefinedValues: variable.predefinedValues
        ? variable.predefinedValues.map((option) => ({
            ...option,
            localizedLabel: getLocalizedContent(option.label, currentLanguage) || option.value,
          }))
        : undefined,
    }));
  };

  const localizedVariables = app?.variables ? localizeVariables(app.variables) : [];

  if (loading) {
    return <LoadingSpinner message={t('app.loading')} />;
  }

  if (error) {
    return (
      <div className="text-center py-12">
        <div className="text-red-500 mb-4">{error}</div>
        <button
          className="bg-indigo-600 text-white px-4 py-2 rounded hover:bg-indigo-700 mr-4"
          onClick={() => window.location.reload()}
        >
          {t('app.retry')}
        </button>
        <button
          className="bg-gray-600 text-white px-4 py-2 rounded hover:bg-gray-700"
          onClick={() => navigate('/')}
        >
          {t('common.back')}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-12rem)]">
      <div className="flex flex-col mb-4 pb-4 border-b">
        <div className="flex items-center mb-3">
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center mr-3"
            style={{ backgroundColor: app?.color }}
          >
            <svg
              className="w-6 h-6 text-white"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
              />
            </svg>
          </div>
          <div>
            <h1 className="text-2xl font-bold">
              {getLocalizedContent(app?.name, currentLanguage) || app?.id}
            </h1>
            <p className="text-gray-600 text-sm">
              {getLocalizedContent(app?.description, currentLanguage) || ''}
            </p>
          </div>
        </div>

        <div className="md:hidden flex flex-wrap gap-2">
          {localizedVariables.length > 0 && (
            <button
              onClick={toggleParameters}
              className="bg-gray-200 hover:bg-gray-300 text-gray-800 px-3 py-1 rounded flex items-center text-sm"
            >
              <svg
                className="w-4 h-4 mr-1"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M7 11l5-5m0 0l5 5m-5-5v12"
                />
              </svg>
              {t('pages.appChat.parameters')}
            </button>
          )}
          <button
            onClick={toggleConfig}
            className="bg-gray-200 hover:bg-gray-300 text-gray-800 px-3 py-1 rounded flex items-center text-sm"
          >
            <svg
              className="w-4 h-4 mr-1"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
            {t('settings.title')}
          </button>
          {messages.length > 0 && (
            <button
              onClick={clearChat}
              className="bg-gray-200 hover:bg-gray-300 text-gray-800 px-3 py-1 rounded flex items-center text-sm"
              title={t('pages.appChat.clearChat')}
            >
              <svg
                className="w-4 h-4 mr-1"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                />
              </svg>
              {t('pages.appChat.clear')}
            </button>
          )}
        </div>

        <div className="hidden md:flex space-x-2 ml-auto">
          {messages.length > 0 && (
            <button
              onClick={clearChat}
              className="bg-gray-200 hover:bg-gray-300 text-gray-800 px-3 py-1 rounded flex items-center"
              title={t('pages.appChat.clearChat')}
            >
              <svg
                className="w-5 h-5 mr-1"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                />
              </svg>
              {t('pages.appChat.clear')}
            </button>
          )}
          <button
            onClick={toggleConfig}
            className="bg-gray-200 hover:bg-gray-300 text-gray-800 px-3 py-1 rounded flex items-center"
          >
            <svg
              className="w-5 h-5 mr-1"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
            {t('settings.title')}
          </button>
        </div>
      </div>

      {showConfig && (
        <div className="bg-gray-100 p-4 rounded-lg mb-4">
          <AppConfigForm
            app={app}
            models={models}
            styles={styles}
            selectedModel={selectedModel}
            selectedStyle={selectedStyle}
            selectedOutputFormat={selectedOutputFormat}
            sendChatHistory={sendChatHistory}
            temperature={temperature}
            onModelChange={setSelectedModel}
            onStyleChange={setSelectedStyle}
            onOutputFormatChange={setSelectedOutputFormat}
            onSendChatHistoryChange={setSendChatHistory}
            onTemperatureChange={setTemperature}
            currentLanguage={currentLanguage}
          />
        </div>
      )}

      {app?.variables && app.variables.length > 0 && showParameters && (
        <div className="md:hidden mb-4 p-4 bg-gray-50 rounded-lg">
          <div className="flex justify-between items-center mb-3">
            <h3 className="font-medium">{t('pages.appChat.inputParameters')}</h3>
            <button
              onClick={toggleParameters}
              className="text-gray-500 hover:text-gray-700"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
          <div className="space-y-3">
            {localizedVariables.map((variable) => (
              <div key={variable.name} className="flex flex-col">
                <label className="mb-1 text-sm font-medium text-gray-700">
                  {variable.localizedLabel}
                  {variable.required && (
                    <span className="text-red-500 ml-1">*</span>
                  )}
                </label>
                {variable.predefinedValues ? (
                  <select
                    value={variables[variable.name] || ''}
                    onChange={(e) =>
                      setVariables({
                        ...variables,
                        [variable.name]: e.target.value,
                      })
                    }
                    className="p-2 border rounded focus:ring-indigo-500 focus:border-indigo-500"
                    required={variable.required}
                  >
                    <option value="">{t('common.select')} {variable.localizedLabel}</option>
                    {variable.predefinedValues.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.localizedLabel}
                      </option>
                    ))}
                  </select>
                ) : variable.type === 'text' ? (
                  <textarea
                    value={variables[variable.name] || ''}
                    onChange={(e) =>
                      setVariables({
                        ...variables,
                        [variable.name]: e.target.value,
                      })
                    }
                    rows={4}
                    className="p-2 border rounded focus:ring-indigo-500 focus:border-indigo-500"
                    placeholder={t('variables.enter') + ' ' + variable.localizedLabel.toLowerCase()}
                    required={variable.required}
                  />
                ) : (
                  <input
                    type="text"
                    value={variables[variable.name] || ''}
                    onChange={(e) =>
                      setVariables({
                        ...variables,
                        [variable.name]: e.target.value,
                      })
                    }
                    className="p-2 border rounded focus:ring-indigo-500 focus:border-indigo-500"
                    placeholder={t('variables.enter') + ' ' + variable.localizedLabel.toLowerCase()}
                    required={variable.required}
                  />
                )}
                {variable.localizedDescription && (
                  <p className="mt-1 text-xs text-gray-500">{variable.localizedDescription}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col md:flex-row flex-1 gap-4 overflow-hidden">
        <div className="flex flex-col flex-1">
          <div
            ref={chatContainerRef}
            className="flex-1 overflow-y-auto mb-4 space-y-4 p-4 bg-gray-50 rounded-lg"
          >
            {messages.length > 0 ? (
              messages.map((message) => (
                <ChatMessage
                  key={message.id}
                  message={message}
                  outputFormat={selectedOutputFormat}
                  onDelete={handleDeleteMessage}
                  onEdit={handleEditMessage}
                  onResend={handleResendMessage}
                  editable={true}
                />
              ))
            ) : (
              <div className="text-center text-gray-500 py-8">
                <svg
                  className="w-16 h-16 mx-auto mb-4 text-gray-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                  />
                </svg>
                <p>{t('pages.appChat.startConversation')}</p>
              </div>
            )}
          </div>

          <form onSubmit={handleSubmit} className="flex space-x-2">
            <input
              type="text"
              value={input}
              onChange={handleInputChange}
              disabled={processing}
              className="flex-1 p-3 border rounded-lg focus:ring-indigo-500 focus:border-indigo-500"
              placeholder={
                processing ? t('pages.appChat.thinking') : t('pages.appChat.messagePlaceholder')
              }
            />
            <button
              type={processing ? 'button' : 'submit'}
              onClick={processing ? cancelGeneration : undefined}
              disabled={!processing && !input.trim()}
              className={`px-4 py-2 rounded-lg font-medium flex items-center justify-center ${
                !processing && !input.trim()
                  ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                  : processing
                  ? 'bg-red-600 text-white hover:bg-red-700'
                  : 'bg-indigo-600 text-white hover:bg-indigo-700'
              }`}
            >
              {processing ? (
                <>
                  <svg
                    className="w-5 h-5 mr-1"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                  <span>{t('common.cancel')}</span>
                </>
              ) : (
                <>
                  <span>{t('common.send')}</span>
                  <svg
                    className="w-5 h-5 ml-1"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M14 5l7 7m0 0l-7 7m7-7H3"
                    />
                  </svg>
                </>
              )}
            </button>
          </form>
        </div>

        {app?.variables && app.variables.length > 0 && (
          <div className="hidden md:block w-80 lg:w-96 overflow-y-auto p-4 bg-gray-50 rounded-lg">
            <h3 className="font-medium mb-3">{t('pages.appChat.inputParameters')}</h3>
            <div className="space-y-3">
              {localizedVariables.map((variable) => (
                <div key={variable.name} className="flex flex-col">
                  <label className="mb-1 text-sm font-medium text-gray-700">
                    {variable.localizedLabel}
                    {variable.required && (
                      <span className="text-red-500 ml-1">*</span>
                    )}
                  </label>
                  {variable.predefinedValues ? (
                    <select
                      value={variables[variable.name] || ''}
                      onChange={(e) =>
                        setVariables({
                          ...variables,
                          [variable.name]: e.target.value,
                        })
                      }
                      className="p-2 border rounded focus:ring-indigo-500 focus:border-indigo-500"
                      required={variable.required}
                    >
                      <option value="">{t('common.select')} {variable.localizedLabel}</option>
                      {variable.predefinedValues.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.localizedLabel}
                        </option>
                      ))}
                    </select>
                  ) : variable.type === 'text' ? (
                    <textarea
                      value={variables[variable.name] || ''}
                      onChange={(e) =>
                        setVariables({
                          ...variables,
                          [variable.name]: e.target.value,
                        })
                      }
                      rows={4}
                      className="p-2 border rounded focus:ring-indigo-500 focus:border-indigo-500"
                      placeholder={t('variables.enter') + ' ' + variable.localizedLabel.toLowerCase()}
                      required={variable.required}
                    />
                  ) : (
                    <input
                      type="text"
                      value={variables[variable.name] || ''}
                      onChange={(e) =>
                        setVariables({
                          ...variables,
                          [variable.name]: e.target.value,
                        })
                      }
                      className="p-2 border rounded focus:ring-indigo-500 focus:border-indigo-500"
                      placeholder={t('variables.enter') + ' ' + variable.localizedLabel.toLowerCase()}
                      required={variable.required}
                    />
                  )}
                  {variable.localizedDescription && (
                    <p className="mt-1 text-xs text-gray-500">{variable.localizedDescription}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default AppChat;