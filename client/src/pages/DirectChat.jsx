import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { fetchModels, sendDirectModelMessage, fetchModelDetails, generateMagicPrompt } from '../api/api';
import LoadingSpinner from '../components/LoadingSpinner';
import { useTranslation } from 'react-i18next';

// Import our custom hooks and components
import useChatMessages from '../utils/useChatMessages';
import useVoiceCommands from '../utils/useVoiceCommands';
import ChatHeader from '../components/chat/ChatHeader';
import ChatInput from '../components/chat/ChatInput';
import ChatMessageList from '../components/chat/ChatMessageList';
import { useUIConfig } from '../components/UIConfigContext';

/**
 * Save direct chat settings to sessionStorage
 * @param {string} modelId - The ID of the model
 * @param {Object} settings - Settings to save
 */
const saveDirectChatSettings = (modelId, settings) => {
  try {
    const key = `ai_hub_direct_chat_settings_${modelId}`;
    sessionStorage.setItem(key, JSON.stringify(settings));
  } catch (error) {
    console.error('Error saving direct chat settings to sessionStorage:', error);
  }
};

/**
 * Load direct chat settings from sessionStorage
 * @param {string} modelId - The ID of the model
 * @returns {Object|null} The saved settings or null if not found
 */
const loadDirectChatSettings = (modelId) => {
  try {
    const key = `ai_hub_direct_chat_settings_${modelId}`;
    const saved = sessionStorage.getItem(key);
    return saved ? JSON.parse(saved) : null;
  } catch (error) {
    console.error('Error loading direct chat settings from sessionStorage:', error);
    return null;
  }
};

const DirectChat = () => {
  const { t } = useTranslation();
  const { modelId } = useParams();
  const navigate = useNavigate();
  const [model, setModel] = useState(null);
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [temperature, setTemperature] = useState(0.7);
  const [currentMessage, setCurrentMessage] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [error, setError] = useState(null);
  const [originalInput, setOriginalInput] = useState(null);
  const [magicLoading, setMagicLoading] = useState(false);
  const inputRef = useRef(null);
  const { resetHeaderColor, uiConfig } = useUIConfig();
  
  // Reference to track if greeting has been added
  const greetingAddedRef = useRef(false);
  
  // Get widget config for greeting fallback
  const widgetConfig = uiConfig?.widget || {};

  // Create a stable chat ID that persists across refreshes
  const [stableChatId] = useState(() => {
    return `direct-chat-${selectedModel || modelId || "default"}`;
  });

  // Use our custom chat messages hook
  const {
    messages,
    addUserMessage,
    addAssistantMessage,
    updateAssistantMessage,
    setMessageError,
    clearMessages
  } = useChatMessages(stableChatId);

  // Fetch model details and models when component mounts
  useEffect(() => {
    // Reset header color when accessing DirectChat
    resetHeaderColor();
    
    const loadData = async () => {
      try {
        const modelsData = await fetchModels();
        setModels(modelsData);
        
        // If modelId is provided, fetch that model's details
        if (modelId) {
          const modelData = await fetchModelDetails(modelId);
          setModel(modelData);
          setSelectedModel(modelId);
        } else if (modelsData.length > 0) {
          // If no modelId is provided, use the first model
          setModel(modelsData[0]);
          setSelectedModel(modelsData[0].id);
        }
        
        setIsLoading(false);
      } catch (error) {
        // Keep error logging for critical errors
        console.error('Error loading model data:', error);
        setError('Failed to load model data. Please try again later.');
        setIsLoading(false);
      }
    };
    
    loadData();
  }, [modelId, resetHeaderColor]);

  // Update the selected model when it changes
  useEffect(() => {
    const updateModel = async () => {
      if (selectedModel) {
        try {
          const modelData = await fetchModelDetails(selectedModel);
          setModel(modelData);
        } catch (error) {
          console.error('Error fetching model details:', error);
          setError('Failed to fetch model details. Please try again.');
        }
      }
    };
    
    updateModel();
  }, [selectedModel]);

  // Load settings from sessionStorage when the component mounts or the model changes
  useEffect(() => {
    if (!isLoading && selectedModel) {
      const savedSettings = loadDirectChatSettings(selectedModel);
      if (savedSettings) {
        // Restore settings if they exist
        if (savedSettings.temperature !== undefined) {
          setTemperature(savedSettings.temperature);
        }
        
        console.log('Restored direct chat settings from sessionStorage:', savedSettings);
      }
    }
  }, [isLoading, selectedModel]);
  
  // Save settings to sessionStorage whenever they change
  useEffect(() => {
    if (!isLoading && selectedModel) {
      const settings = {
        temperature,
      };
      
      saveDirectChatSettings(selectedModel, settings);
    }
  }, [isLoading, selectedModel, temperature]);

  // Display greeting message when model is loaded and no messages exist yet
  useEffect(() => {
    // Only add greeting message when model is loaded, messages are empty, and we haven't added it yet
    if (model && !isLoading && messages.length === 0 && !greetingAddedRef.current) {
      console.log('[DirectChat] Adding greeting message when model loaded');
      
      // Get language for localization
      const userLanguage = t.language?.split('-')[0].toLowerCase() || 'en';
      
      // Try to get model-specific greeting first
      let greeting = null;
      
      // Check if model has its own greeting
      if (model.greeting) {
        greeting = typeof model.greeting === 'object' 
          ? (model.greeting[userLanguage] || model.greeting.en)
          : model.greeting;
      }
      
      // Fall back to widget greeting if model doesn't have one
      if (!greeting && widgetConfig.greeting) {
        greeting = widgetConfig.greeting[userLanguage] || widgetConfig.greeting.en;
      }
      
      // If we have a greeting, display it
      if (greeting) {
        // Create a greeting message and immediately mark it as not loading
        const greetingId = addAssistantMessage();
        updateAssistantMessage(greetingId, greeting, false);
        
        greetingAddedRef.current = true;
      }
    }
    
    // Reset the greeting flag when chat is cleared
    if (messages.length === 0) {
      greetingAddedRef.current = false;
    }
  }, [model, isLoading, messages.length, addAssistantMessage, updateAssistantMessage, t.language, widgetConfig]);

  const handleInputChange = (e) => {
    setCurrentMessage(e.target.value);
  };

  const handleMagicPrompt = async () => {
    if (!currentMessage.trim()) return;
    try {
      setMagicLoading(true);
      const response = await generateMagicPrompt(currentMessage, {
        prompt: widgetConfig?.features?.magicPrompt?.prompt,
        modelId: widgetConfig?.features?.magicPrompt?.model,
        appId: 'direct'
      });
      if (response && response.prompt) {
        setOriginalInput(currentMessage);
        setCurrentMessage(response.prompt);
      }
    } catch (err) {
      console.error('Error generating magic prompt:', err);
    } finally {
      setMagicLoading(false);
    }
  };

  const handleUndoMagicPrompt = () => {
    if (originalInput !== null) {
      setCurrentMessage(originalInput);
      setOriginalInput(null);
    }
  };

  // Function to clear chat history with confirmation
  const handleClearChat = () => {
    if (messages.length > 0) {
      if (window.confirm(t('pages.directChat.confirmClear', 'Are you sure you want to clear the entire chat history?'))) {
        clearMessages();
      }
    }
  };

  // Set up voice commands
  const { handleVoiceInput, handleVoiceCommand } = useVoiceCommands({
    messages,
    clearChat: clearMessages,
    sendMessage: (text) => {
      setCurrentMessage(text);
      setTimeout(() => handleSendMessage({ preventDefault: () => {} }), 0);
    },
    isProcessing: isSending,
    currentText: currentMessage,
    onConfirmClear: () => window.confirm(t('pages.directChat.confirmClear', 'Are you sure you want to clear the entire chat history?'))
  });

  const handleSendMessage = async (e) => {
    e.preventDefault();
    
    if (!currentMessage.trim() || isSending) return;
    
    try {
      setIsSending(true);
      
      // Add user message to the chat
      addUserMessage(currentMessage);
      setCurrentMessage('');
      setOriginalInput(null);
      
      // Add placeholder for assistant's response
      const assistantId = addAssistantMessage();
      
      // Send the message to the API
      const options = {
        temperature: parseFloat(temperature)
      };
      
      const messagesForApi = messages.concat([{ role: 'user', content: currentMessage }]);
      const response = await sendDirectModelMessage(selectedModel, messagesForApi, options);
      
      // Update the assistant's message with the response
      updateAssistantMessage(
        assistantId, 
        response.choices[0].message.content,
        false // Not loading anymore
      );
      
    } catch (error) {
      console.error('Error sending message:', error);
      
      // Update the assistant's message with the error
      setMessageError(
        assistantId, 
        'Sorry, an error occurred while generating a response.'
      );
      
    } finally {
      setIsSending(false);
    }
  };

  const handleStopGeneration = () => {
    // For DirectChat, we can't stop the generation once it's sent
    // since it's not using streaming. But we can update the UI state.
    setIsSending(false);
    
    // Update the last message to indicate it was stopped
    if (messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      if (lastMessage.role === 'assistant' && lastMessage.loading) {
        updateAssistantMessage(
          lastMessage.id,
          'Message generation was cancelled.',
          false
        );
      }
    }
  };

  const toggleConfig = () => {
    setShowConfig(!showConfig);
  };

  if (isLoading) {
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

  if (!model) {
    return (
      <div className="text-center py-12">
        <div className="text-red-500 mb-4">{t('error.modelNotFound')}</div>
        <button 
          className="bg-gray-600 text-white px-4 py-2 rounded hover:bg-gray-700"
          onClick={() => navigate('/')}
        >
          {t('common.back')}
        </button>
      </div>
    );
  }

  // Determine header color based on model provider
  const headerColor = model?.provider === 'openai' ? '#10a37f' : 
                      model?.provider === 'google' ? '#4285f4' : 
                      model?.provider === 'anthropic' ? '#d09a62' : '#6b7280';

  // Custom icon for model providers
  const modelIcon = (
    <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
    </svg>
  );

  return (
    <div className="flex flex-col h-[calc(100vh-12rem)]">
      {/* Model Header - using our reusable ChatHeader component */}
      <ChatHeader
        title={`${t('pages.directChat.title', 'Direct Chat with')} ${model?.name}`}
        description={model?.description}
        color={headerColor}
        icon={modelIcon}
        showClearButton={messages.length > 0}
        showConfigButton={true}
        onClearChat={handleClearChat}
        onToggleConfig={toggleConfig}
      />
      
      {/* Config Panel */}
      {showConfig && (
        <div className="bg-gray-100 p-4 rounded-lg mb-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t('appConfig.model', 'Model')}</label>
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="w-full border border-gray-300 rounded-md p-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                disabled={isSending}
              >
                {models.map((modelOption) => (
                  <option key={modelOption.id} value={modelOption.id}>
                    {modelOption.name}
                  </option>
                ))}
              </select>
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t('models.temperature')}</label>
              <input
                type="range"
                min="0"
                max="1"
                step="0.1"
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
                className="w-full"
                disabled={isSending}
              />
              <div className="text-xs text-gray-500 flex justify-between">
                <span>{t('common.precise')} ({temperature})</span>
                <span>{t('common.creative')}</span>
              </div>
            </div>
          </div>
        </div>
      )}
      
      {/* Chat Messages - using our reusable ChatMessageList component */}
      <ChatMessageList
        messages={messages}
        outputFormat="markdown"
        appId="direct-chat"
        chatId={modelId || "default"}
        modelId={selectedModel}
      />
      
      {/* Message Input - using our reusable ChatInput component */}
      <ChatInput
        value={currentMessage}
        onChange={handleInputChange}
        onSubmit={handleSendMessage}
        isProcessing={isSending}
        onCancel={handleStopGeneration}
        onVoiceInput={handleVoiceInput}
        onVoiceCommand={handleVoiceCommand}
        inputRef={inputRef}
        magicPromptEnabled={widgetConfig?.features?.magicPrompt?.enabled === true}
        onMagicPrompt={handleMagicPrompt}
        showUndoMagicPrompt={originalInput !== null}
        onUndoMagicPrompt={handleUndoMagicPrompt}
        magicPromptLoading={magicLoading}
      />
    </div>
  );
};

export default DirectChat;