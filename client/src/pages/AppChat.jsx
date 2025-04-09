import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { fetchAppDetails, fetchModels, fetchStyles, sendAppChatMessage } from '../api/api';
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

  const chatContainerRef = useRef(null);
  const chatId = useRef(`chat-${Date.now()}`);
  const eventSourceRef = useRef(null);

  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

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
            // Process localized default values
            const localizedDefaultValue = typeof variable.defaultValue === 'object' 
              ? getLocalizedContent(variable.defaultValue, i18n.language) 
              : variable.defaultValue || '';
            
            initialVars[variable.name] = localizedDefaultValue;
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
        setError('Failed to load application data. Please try again later.');
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, [appId, setHeaderColor]);

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
              : [
                  ...currentMessages.map((msg) => {
                    const { id, loading, error, ...apiMsg } = msg;
                    return apiMsg;
                  }),
                ];

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

          eventSource.addEventListener('connected', async () => {
            console.log('SSE connection established, sending edited chat message');

            try {
              await sendAppChatMessage(appId, chatId.current, messagesForAPI, {
                modelId: selectedModel,
                style: selectedStyle,
                temperature,
                outputFormat: selectedOutputFormat,
              });
            } catch (postError) {
              console.error('Error sending chat message:', postError);

              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === assistantMessageId
                    ? {
                        ...msg,
                        content:
                          'Error: Failed to generate response. Please try again or select a different model.',
                        loading: false,
                        error: true,
                      }
                    : msg
                )
              );

              eventSource.close();
              setProcessing(false);
            }
          });

          eventSource.addEventListener('chunk', (event) => {
            const data = JSON.parse(event.data);
            fullContent += data.content;

            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === assistantMessageId
                  ? { ...msg, content: fullContent, loading: true }
                  : msg
              )
            );
          });

          eventSource.addEventListener('done', () => {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === assistantMessageId ? { ...msg, loading: false } : msg
              )
            );
            eventSource.close();
            setProcessing(false);
          });

          eventSource.addEventListener('error', (event) => {
            console.error('SSE Error:', event);

            let errorMessage = 'Error receiving response. Please try again.';
            try {
              if (event.data) {
                const errorData = JSON.parse(event.data);
                if (errorData.message) {
                  if (errorData.message.includes('API key not found')) {
                    errorMessage = `${errorData.message}. Please check your API configuration.`;
                  } else {
                    errorMessage = errorData.message;
                  }
                }
              }
            } catch (e) {
              console.log('Could not parse error data:', e);
            }

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
            setProcessing(false);
          });
        } catch (err) {
          console.error('Error sending message:', err);

          setMessages((prev) => [
            ...prev,
            {
              id: Date.now(),
              role: 'system',
              content: `Error: Failed to send message. ${
                err.message || 'Please try again.'
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
          'pages.appChat.clearConfirmation',
          'Are you sure you want to clear the entire chat history?'
        )
      )
    ) {
      setMessages([]);
      chatId.current = `chat-${Date.now()}`;
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!input.trim() && Object.keys(variables).length === 0) return;

    if (app?.variables) {
      const missingRequiredVars = app.variables
        .filter((v) => v.required)
        .filter((v) => !variables[v.name]);

      if (missingRequiredVars.length > 0) {
        setError(
          t(
            'pages.appChat.missingFields',
            'Please fill in all required fields:'
          ) +
            ' ' +
            missingRequiredVars.map((v) => v.label).join(', ')
        );
        return;
      }
    }

    try {
      setProcessing(true);
      setError(null);

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
          : [...messages, messageForAPI];

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

      eventSource.addEventListener('connected', async () => {
        connectionEstablished = true;
        console.log('SSE connection established, sending chat message');

        try {
          await sendAppChatMessage(appId, chatId.current, messagesForAPI, {
            modelId: selectedModel,
            style: selectedStyle,
            temperature,
            outputFormat: selectedOutputFormat,
          });
        } catch (postError) {
          console.error('Error sending chat message:', postError);

          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMessageId
                ? {
                    ...msg,
                    content: t(
                      'pages.appChat.errorResponse',
                      'Error: Failed to generate response. Please try again or select a different model.'
                    ),
                    loading: false,
                    error: true,
                  }
                : msg
            )
          );

          eventSource.close();
          setProcessing(false);
        }
      });

      eventSource.addEventListener('chunk', (event) => {
        const data = JSON.parse(event.data);
        fullContent += data.content;

        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMessageId
              ? { ...msg, content: fullContent, loading: true }
              : msg
          )
        );
      });

      eventSource.addEventListener('done', () => {
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMessageId ? { ...msg, loading: false } : msg
          )
        );
        eventSource.close();
        setProcessing(false);
      });

      eventSource.addEventListener('error', (event) => {
        console.error('SSE Error:', event);

        let errorMessage = t(
          'pages.appChat.errorReceivingResponse',
          'Error receiving response. Please try again.'
        );
        try {
          if (event.data) {
            const errorData = JSON.parse(event.data);
            if (errorData.message) {
              if (errorData.message.includes('API key not found')) {
                errorMessage = `${errorData.message}. ${t(
                  'pages.appChat.checkAPIConfig',
                  'Please check your API configuration.'
                )}`;
              } else {
                errorMessage = errorData.message;
              }
            }
          }
        } catch (e) {
          console.log('Could not parse error data:', e);
        }

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
        setProcessing(false);
      });
    } catch (err) {
      console.error('Error sending message:', err);

      setMessages((prev) => [
        ...prev,
        {
          id: Date.now(),
          role: 'system',
          content: `Error: ${t(
            'pages.appChat.failedToSendMessage',
            'Failed to send message.'
          )} ${
            err.message || t('pages.appChat.tryAgain', 'Please try again.')
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
      localizedLabel: getLocalizedContent(variable.label, currentLanguage),
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
            localizedLabel: getLocalizedContent(option.label, currentLanguage),
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
        {/* App Header - Icon and Title */}
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
              {getLocalizedContent(app?.name, currentLanguage)}
            </h1>
            <p className="text-gray-600 text-sm">
              {getLocalizedContent(app?.description, currentLanguage)}
            </p>
          </div>
        </div>
        
        {/* Mobile buttons (shown below header on small screens) */}
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
        
        {/* Desktop buttons (horizontal) */}
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
              type="submit"
              disabled={
                processing || (!input.trim() && Object.keys(variables).length === 0)
              }
              className={`px-4 py-2 rounded-lg font-medium flex items-center justify-center ${
                processing || (!input.trim() && Object.keys(variables).length === 0)
                  ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                  : 'bg-indigo-600 text-white hover:bg-indigo-700'
              }`}
            >
              {processing ? (
                <svg
                  className="animate-spin h-5 w-5 text-white"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  ></circle>
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  ></path>
                </svg>
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