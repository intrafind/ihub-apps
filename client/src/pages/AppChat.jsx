import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { fetchAppDetails, fetchModels, fetchStyles, sendAppChatMessage } from '../api/api';
import ChatMessage from '../components/ChatMessage';
import AppConfigForm from '../components/AppConfigForm';
import LoadingSpinner from '../components/LoadingSpinner';
import { useHeaderColor } from '../components/HeaderColorContext';

const AppChat = () => {
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

        // Set the header color based on the app's color
        if (appData?.color) {
          setHeaderColor(appData.color);
        }

        setTemperature(appData.preferredTemperature || 0.7);
        setSelectedStyle(appData.preferredStyle || 'normal');

        if (appData.variables) {
          const initialVars = {};
          appData.variables.forEach((variable) => {
            initialVars[variable.name] = variable.defaultValue || '';
          });
          setVariables(initialVars);
        }

        const modelsData = await fetchModels();
        setModels(modelsData);

        setSelectedModel(appData.preferredModel);

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

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!input.trim() && Object.keys(variables).length === 0) return;

    if (app?.variables) {
      const missingRequiredVars = app.variables
        .filter((v) => v.required)
        .filter((v) => !variables[v.name]);

      if (missingRequiredVars.length > 0) {
        setError(
          `Please fill in all required fields: ${missingRequiredVars
            .map((v) => v.label)
            .join(', ')}`
        );
        return;
      }
    }

    try {
      setProcessing(true);
      setError(null);

      // Store the original user input for display in chat history
      const originalUserInput = input;
      
      // Create a user message that shows just the actual input in the UI
      const newUserMessage = {
        role: 'user',
        content: originalUserInput,
      };
      
      // Add the new user message to the chat history
      setMessages((prev) => [...prev, newUserMessage]);
      setInput('');

      // For the API call, we send both the original input and the prompt template with variables
      // This keeps the displayed message clean while providing the server with everything needed
      const messageForAPI = {
        role: 'user',
        content: originalUserInput,
        // Include the prompt template and variables separately for server-side processing
        promptTemplate: app?.prompt || null,
        variables: { ...variables },
      };

      // Create a copy of messages for the API call that includes our special messageForAPI
      const messagesForAPI = [...messages, messageForAPI];

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

      eventSource.addEventListener('connected', async () => {
        connectionEstablished = true;
        console.log('SSE connection established, sending chat message');

        try {
          // Use the messagesForAPI array which includes the prompt template and variables
          await sendAppChatMessage(appId, chatId.current, messagesForAPI, {
            modelId: selectedModel,
            style: selectedStyle,
            temperature,
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
  };

  const toggleConfig = () => {
    setShowConfig(!showConfig);
  };

  const toggleParameters = () => {
    setShowParameters(!showParameters);
  };

  if (loading) {
    return <LoadingSpinner message="Loading application..." />;
  }

  if (error) {
    return (
      <div className="text-center py-12">
        <div className="text-red-500 mb-4">{error}</div>
        <button
          className="bg-indigo-600 text-white px-4 py-2 rounded hover:bg-indigo-700 mr-4"
          onClick={() => window.location.reload()}
        >
          Retry
        </button>
        <button
          className="bg-gray-600 text-white px-4 py-2 rounded hover:bg-gray-700"
          onClick={() => navigate('/')}
        >
          Back to Apps
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-12rem)]">
      <div className="flex justify-between items-center mb-4 pb-4 border-b">
        <div className="flex items-center">
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
            <h1 className="text-2xl font-bold">{app?.name}</h1>
            <p className="text-gray-600 text-sm">{app?.description}</p>
          </div>
        </div>
        <div className="flex space-x-2">
          {app?.variables && app.variables.length > 0 && (
            <button
              onClick={toggleParameters}
              className="md:hidden bg-gray-200 hover:bg-gray-300 text-gray-800 px-3 py-1 rounded flex items-center"
            >
              Parameters
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
            Settings
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
            temperature={temperature}
            onModelChange={setSelectedModel}
            onStyleChange={setSelectedStyle}
            onTemperatureChange={setTemperature}
          />
        </div>
      )}

      {app?.variables && app.variables.length > 0 && showParameters && (
        <div className="md:hidden mb-4 p-4 bg-gray-50 rounded-lg">
          <div className="flex justify-between items-center mb-3">
            <h3 className="font-medium">Input Parameters</h3>
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
            {app.variables.map((variable) => (
              <div key={variable.name} className="flex flex-col">
                <label className="mb-1 text-sm font-medium text-gray-700">
                  {variable.label}
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
                    <option value="">Select {variable.label}</option>
                    {variable.predefinedValues.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
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
                    placeholder={`Enter ${variable.label.toLowerCase()}`}
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
                    placeholder={`Enter ${variable.label.toLowerCase()}`}
                    required={variable.required}
                  />
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
              messages.map((message, index) => (
                <ChatMessage
                  key={index}
                  message={message}
                  outputFormat={app?.preferredOutputFormat}
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
                <p>Start the conversation by sending a message below.</p>
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
                processing ? 'Processing...' : 'Type your message...'
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
                  <span>Send</span>
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
            <h3 className="font-medium mb-3">Input Parameters</h3>
            <div className="space-y-3">
              {app.variables.map((variable) => (
                <div key={variable.name} className="flex flex-col">
                  <label className="mb-1 text-sm font-medium text-gray-700">
                    {variable.label}
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
                      <option value="">Select {variable.label}</option>
                      {variable.predefinedValues.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
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
                      placeholder={`Enter ${variable.label.toLowerCase()}`}
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
                      placeholder={`Enter ${variable.label.toLowerCase()}`}
                      required={variable.required}
                    />
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