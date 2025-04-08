import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { fetchModels, sendDirectModelMessage, fetchModelDetails } from '../api/api';
import ChatMessage from '../components/ChatMessage';
import LoadingSpinner from '../components/LoadingSpinner';
import { useHeaderColor } from '../components/HeaderColorContext';

const DirectChat = () => {
  const { modelId } = useParams();
  const navigate = useNavigate();
  const [model, setModel] = useState(null);
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [temperature, setTemperature] = useState(0.7);
  const [messages, setMessages] = useState([]);
  const [currentMessage, setCurrentMessage] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [error, setError] = useState(null);
  const chatContainerRef = useRef(null);
  const messageEndRef = useRef(null);
  const { resetHeaderColor } = useHeaderColor();

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

  // Scroll to bottom when messages change
  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [messages]);

  const handleMessageChange = (e) => {
    setCurrentMessage(e.target.value);
  };

  const handleSendMessage = async (e) => {
    e.preventDefault();
    
    if (!currentMessage.trim() || isSending) return;
    
    try {
      setIsSending(true);
      
      // Add user message to the chat
      const newUserMessage = { role: 'user', content: currentMessage };
      const newMessages = [...messages, newUserMessage];
      setMessages(newMessages);
      setCurrentMessage('');
      
      // Add placeholder for assistant's response
      setMessages([...newMessages, { role: 'assistant', content: '', loading: true }]);
      
      // Send the message to the API
      const options = {
        temperature: parseFloat(temperature)
      };
      
      const response = await sendDirectModelMessage(selectedModel, newMessages, options);
      
      // Update the assistant's message with the response
      setMessages(prev => {
        const updated = [...prev];
        // Remove the loading indicator and update with the actual response
        updated[updated.length - 1] = {
          role: 'assistant',
          content: response.choices[0].message.content
        };
        return updated;
      });
      
    } catch (error) {
      console.error('Error sending message:', error);
      
      // Update the assistant's message with the error
      setMessages(prev => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          role: 'assistant',
          content: 'Sorry, an error occurred while generating a response.',
          error: true
        };
        return updated;
      });
      
    } finally {
      setIsSending(false);
    }
  };

  const handleStopGeneration = () => {
    // For DirectChat, we can't stop the generation once it's sent
    // since it's not using streaming. But we can update the UI state.
    setIsSending(false);
    
    // Update the message to indicate it was stopped
    setMessages(prev => {
      const updated = [...prev];
      const lastMessage = updated[updated.length - 1];
      if (lastMessage.role === 'assistant' && lastMessage.loading) {
        lastMessage.content = 'Message generation was cancelled.';
        lastMessage.loading = false;
      }
      return updated;
    });
  };

  const toggleConfig = () => {
    setShowConfig(!showConfig);
  };

  if (isLoading) {
    return <LoadingSpinner message="Loading model..." />;
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
          Back to Models
        </button>
      </div>
    );
  }

  if (!model) {
    return (
      <div className="text-center py-12">
        <div className="text-red-500 mb-4">Model not found.</div>
        <button 
          className="bg-gray-600 text-white px-4 py-2 rounded hover:bg-gray-700"
          onClick={() => navigate('/')}
        >
          Back to Models
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-12rem)]">
      {/* Model Header */}
      <div className="flex justify-between items-center mb-4 pb-4 border-b">
        <div className="flex items-center">
          <div 
            className="w-10 h-10 rounded-full flex items-center justify-center mr-3"
            style={{ backgroundColor: model?.provider === 'openai' ? '#10a37f' : 
                     model?.provider === 'google' ? '#4285f4' : 
                     model?.provider === 'anthropic' ? '#d09a62' : '#6b7280' }}
          >
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          </div>
          <div>
            <h1 className="text-2xl font-bold">Direct Chat with {model?.name}</h1>
            <p className="text-gray-600 text-sm">{model?.description}</p>
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
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Model</label>
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
              <label className="block text-sm font-medium text-gray-700 mb-1">Temperature</label>
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
                <span>Precise ({temperature})</span>
                <span>Creative</span>
              </div>
            </div>
          </div>
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
              outputFormat="markdown"
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
      
      {/* Message Input */}
      <form onSubmit={handleSendMessage} className="flex space-x-2">
        <input
          type="text"
          value={currentMessage}
          onChange={handleMessageChange}
          disabled={isSending}
          className="flex-1 p-3 border rounded-lg focus:ring-indigo-500 focus:border-indigo-500"
          placeholder={isSending ? "Generating response..." : "Type your message..."}
        />
        <button
          type="submit"
          disabled={isSending || !currentMessage.trim()}
          className={`px-4 py-2 rounded-lg font-medium flex items-center justify-center ${
            isSending || !currentMessage.trim()
              ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
              : 'bg-indigo-600 text-white hover:bg-indigo-700'
          }`}
          onClick={isSending ? handleStopGeneration : undefined}
        >
          {isSending ? (
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

export default DirectChat;