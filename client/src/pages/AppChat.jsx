import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { fetchAppDetails, fetchModels, fetchStyles, sendAppChatMessage } from '../api/api';
import ChatMessage from '../components/ChatMessage';
import AppConfigForm from '../components/AppConfigForm';
import LoadingSpinner from '../components/LoadingSpinner';

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
  
  const chatContainerRef = useRef(null);
  const chatId = useRef(`chat-${Date.now()}`);
  // Create a ref to store the current EventSource instance
  const eventSourceRef = useRef(null);

  // Cleanup function for the EventSource when component unmounts
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  // Load app details and models
  useEffect(() => {
    const loadData = async () => {
      try {
        setLoading(true);
        
        // Fetch app details
        const appData = await fetchAppDetails(appId);
        setApp(appData);
        
        // Set default temperature
        setTemperature(appData.preferredTemperature || 0.7);
        
        // Set default style
        setSelectedStyle(appData.preferredStyle || 'normal');
        
        // Initialize variables object from app.variables with default values
        if (appData.variables) {
          const initialVars = {};
          appData.variables.forEach(variable => {
            // Set default value if provided in config, otherwise empty string
            initialVars[variable.name] = variable.defaultValue || '';
          });
          setVariables(initialVars);
        }
        
        // Fetch models
        const modelsData = await fetchModels();
        setModels(modelsData);
        
        // Set preferred model from app
        setSelectedModel(appData.preferredModel);
        
        // Fetch available styles
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
  }, [appId]);

  // Scroll to bottom when messages change
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
    
    // Check if we have content to send
    if (!input.trim() && Object.keys(variables).length === 0) return;
    
    // Validate that all required variables have values
    if (app?.variables) {
      const missingRequiredVars = app.variables
        .filter(v => v.required)
        .filter(v => !variables[v.name]);
      
      if (missingRequiredVars.length > 0) {
        // Show error for missing required fields
        setError(`Please fill in all required fields: ${missingRequiredVars.map(v => v.label).join(', ')}`);
        return;
      }
    }
    
    try {
      setProcessing(true);
      // Clear any previous global errors
      setError(null);
      
      // If this is a custom prompt with variables, process it
      let userMessage = input;
      let userVariables = {};
      
      if (app && app.prompt) {
        // Replace variables in the prompt template
        userMessage = app.prompt;
        let processedVariables = {...variables};
        
        // Store the variables for display
        userVariables = {...variables};
        
        // If the app uses a content variable but it's not explicitly defined in variables,
        // use the input box text as the content
        if (app.prompt.includes('{{content}}') && !app.variables?.some(v => v.name === 'content')) {
          processedVariables.content = input;
        }
        
        // Replace all variables in the template
        for (const [key, value] of Object.entries(processedVariables)) {
          userMessage = userMessage.replace(`{{${key}}}`, value || '');
        }
      }
      
      // Add user message to chat with variables for context
      const newUserMessage = { 
        role: 'user', 
        content: userMessage,
        variables: userVariables // Store variables with the message
      };
      setMessages(prev => [...prev, newUserMessage]);
      
      // Clear input field but keep variable values - don't reset them to defaults
      setInput('');
      
      // Need to manually add the message since we're updating state
      const updatedMessages = [...messages, newUserMessage];
      
      // Create assistant message placeholder
      const assistantMessageId = Date.now();
      setMessages(prev => [...prev, { 
        id: assistantMessageId, 
        role: 'assistant', 
        content: '', 
        loading: true 
      }]);
      
      // IMPORTANT: First establish the EventSource connection
      // This ensures the client is registered on the server before sending the POST request
      const eventSource = new EventSource(`/api/apps/${appId}/chat/${chatId.current}`);
      eventSourceRef.current = eventSource;
      
      let fullContent = '';
      let connectionEstablished = false;
      
      // Setup event listeners
      eventSource.addEventListener('connected', async () => {
        // Connection is established, now send the POST request
        connectionEstablished = true;
        console.log('SSE connection established, sending chat message');
        
        try {
          await sendAppChatMessage(
            appId,
            chatId.current,
            updatedMessages,
            {
              modelId: selectedModel,
              style: selectedStyle,
              temperature
            }
          );
        } catch (postError) {
          console.error('Error sending chat message:', postError);
          
          // Update the assistant message to show error instead of setting global error
          setMessages(prev => 
            prev.map(msg => 
              msg.id === assistantMessageId 
                ? { 
                    ...msg, 
                    content: 'Error: Failed to generate response. Please try again or select a different model.',
                    loading: false,
                    error: true
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
        
        // Update the assistant message with new content
        setMessages(prev => 
          prev.map(msg => 
            msg.id === assistantMessageId 
              ? { ...msg, content: fullContent, loading: true } 
              : msg
          )
        );
      });
      
      eventSource.addEventListener('done', () => {
        // Mark message as complete
        setMessages(prev => 
          prev.map(msg => 
            msg.id === assistantMessageId 
              ? { ...msg, loading: false } 
              : msg
          )
        );
        eventSource.close();
        setProcessing(false);
      });
      
      eventSource.addEventListener('error', (event) => {
        console.error('SSE Error:', event);
        
        // Parse error message if possible
        let errorMessage = 'Error receiving response. Please try again.';
        try {
          if (event.data) {
            const errorData = JSON.parse(event.data);
            if (errorData.message) {
              // Handle specific errors like missing API keys
              if (errorData.message.includes("API key not found")) {
                errorMessage = `${errorData.message}. Please check your API configuration.`;
              } else {
                errorMessage = errorData.message;
              }
            }
          }
        } catch (e) {
          console.log('Could not parse error data:', e);
        }
        
        // Update the assistant message to show error instead of setting global error
        setMessages(prev => 
          prev.map(msg => 
            msg.id === assistantMessageId 
              ? { 
                  ...msg, 
                  content: `Error: ${errorMessage}`, 
                  loading: false,
                  error: true
                } 
              : msg
          )
        );
        
        eventSource.close();
        setProcessing(false);
      });
      
    } catch (err) {
      console.error('Error sending message:', err);
      
      // Add error as a system message instead of setting global error
      setMessages(prev => [...prev, {
        id: Date.now(),
        role: 'system',
        content: `Error: Failed to send message. ${err.message || 'Please try again.'}`,
        error: true
      }]);
      
      setProcessing(false);
    }
  };

  const toggleConfig = () => {
    setShowConfig(!showConfig);
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
      {/* App Header */}
      <div className="flex justify-between items-center mb-4 pb-4 border-b">
        <div className="flex items-center">
          <div 
            className="w-10 h-10 rounded-full flex items-center justify-center mr-3"
            style={{ backgroundColor: app?.color }}
          >
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
            </svg>
          </div>
          <div>
            <h1 className="text-2xl font-bold">{app?.name}</h1>
            <p className="text-gray-600 text-sm">{app?.description}</p>
          </div>
        </div>
        <button 
          onClick={toggleConfig}
          className="bg-gray-200 hover:bg-gray-300 text-gray-800 px-3 py-1 rounded flex items-center"
        >
          <svg className="w-5 h-5 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          Settings
        </button>
      </div>
      
      {/* Config Panel */}
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
      
      {/* Chat Messages */}
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
            <svg className="w-16 h-16 mx-auto mb-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            <p>Start the conversation by sending a message below.</p>
          </div>
        )}
      </div>
      
      {/* Variables Form - Always visible if app has variables */}
      {app?.variables && app.variables.length > 0 && (
        <div className="mb-4 p-4 bg-gray-50 rounded-lg">
          <h3 className="font-medium mb-3">Input Parameters</h3>
          <div className="space-y-3">
            {app.variables.map((variable) => (
              <div key={variable.name} className="flex flex-col">
                <label className="mb-1 text-sm font-medium text-gray-700">
                  {variable.label}
                  {variable.required && <span className="text-red-500 ml-1">*</span>}
                </label>
                {variable.predefinedValues ? (
                  <select
                    value={variables[variable.name] || ''}
                    onChange={(e) => setVariables({
                      ...variables,
                      [variable.name]: e.target.value
                    })}
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
                ) : (
                  variable.type === 'text' ? (
                    <textarea
                      value={variables[variable.name] || ''}
                      onChange={(e) => setVariables({
                        ...variables,
                        [variable.name]: e.target.value
                      })}
                      rows={4}
                      className="p-2 border rounded focus:ring-indigo-500 focus:border-indigo-500"
                      placeholder={`Enter ${variable.label.toLowerCase()}`}
                      required={variable.required}
                    />
                  ) : (
                    <input
                      type="text"
                      value={variables[variable.name] || ''}
                      onChange={(e) => setVariables({
                        ...variables,
                        [variable.name]: e.target.value
                      })}
                      className="p-2 border rounded focus:ring-indigo-500 focus:border-indigo-500"
                      placeholder={`Enter ${variable.label.toLowerCase()}`}
                      required={variable.required}
                    />
                  )
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      
      {/* Message Input */}
      <form onSubmit={handleSubmit} className="flex space-x-2">
        <input
          type="text"
          value={input}
          onChange={handleInputChange}
          disabled={processing}
          className="flex-1 p-3 border rounded-lg focus:ring-indigo-500 focus:border-indigo-500"
          placeholder={processing ? "Processing..." : "Type your message..."}
        />
        <button
          type="submit"
          disabled={processing || (!input.trim() && Object.keys(variables).length === 0)}
          className={`px-4 py-2 rounded-lg font-medium flex items-center justify-center ${
            processing || (!input.trim() && Object.keys(variables).length === 0)
              ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
              : 'bg-indigo-600 text-white hover:bg-indigo-700'
          }`}
        >
          {processing ? (
            <svg className="animate-spin h-5 w-5 text-white" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
          ) : (
            <>
              <span>Send</span>
              <svg className="w-5 h-5 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
              </svg>
            </>
          )}
        </button>
      </form>
    </div>
  );
};

export default AppChat;