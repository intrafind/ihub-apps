import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { fetchModels, sendDirectModelMessage, fetchModelDetails } from '../api/api';
import ChatMessage from '../components/ChatMessage';
import LoadingSpinner from '../components/LoadingSpinner';

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
  const chatContainerRef = useRef(null);
  const messageEndRef = useRef(null);

  // Fetch model details and models when component mounts
  useEffect(() => {
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
        setIsLoading(false);
      }
    };
    
    loadData();
  }, [modelId]);

  // Update the selected model when it changes
  useEffect(() => {
    const updateModel = async () => {
      if (selectedModel) {
        try {
          const modelData = await fetchModelDetails(selectedModel);
          setModel(modelData);
        } catch (error) {
          console.error('Error fetching model details:', error);
        }
      }
    };
    
    updateModel();
  }, [selectedModel]);

  // Scroll to bottom when messages change
  useEffect(() => {
    if (messageEndRef.current) {
      messageEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

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
      setMessages([...newMessages, { role: 'assistant', content: '', isLoading: true }]);
      
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
          content: 'Sorry, an error occurred while generating a response.'
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
      if (lastMessage.role === 'assistant' && lastMessage.isLoading) {
        lastMessage.content = 'Message generation was cancelled.';
        lastMessage.isLoading = false;
      }
      return updated;
    });
  };

  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-screen">
        <LoadingSpinner />
      </div>
    );
  }

  if (!model) {
    return (
      <div className="container mx-auto p-4">
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
          <p>Model not found. <button onClick={() => navigate('/')} className="underline">Return to home</button></p>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-4 max-w-4xl">
      <div className="bg-white rounded-lg shadow-md p-6 mb-6">
        <h1 className="text-2xl font-bold mb-2">Direct Chat with {model.name}</h1>
        <p className="text-gray-600 mb-4">{model.description}</p>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Model</label>
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
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
      
      <div className="bg-white rounded-lg shadow-md h-[calc(100vh-16rem)]">
        <div ref={chatContainerRef} className="h-[calc(100%-5rem)] overflow-y-auto p-4">
          {messages.map((message, index) => (
            <ChatMessage key={index} message={message} />
          ))}
          <div ref={messageEndRef} />
        </div>
        
        <form onSubmit={handleSendMessage} className="border-t border-gray-200 p-4 flex">
          <input
            type="text"
            value={currentMessage}
            onChange={(e) => setCurrentMessage(e.target.value)}
            placeholder="Type your message..."
            className="flex-grow border border-gray-300 rounded-l-md px-4 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            disabled={isSending}
          />
          <button
            type="submit"
            className={`px-4 py-2 rounded-r-md focus:outline-none ${
              isSending 
                ? 'bg-red-600 hover:bg-red-700 text-white' 
                : 'bg-indigo-600 hover:bg-indigo-700 text-white'
            }`}
            onClick={isSending ? handleStopGeneration : undefined}
          >
            {isSending ? (
              <>
                Stop
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 ml-1 inline" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8 7a1 1 0 00-1 1v4a1 1 0 001 1h4a1 1 0 001-1V8a1 1 0 00-1-1H8z" clipRule="evenodd" />
                </svg>
              </>
            ) : (
              <>
                Send
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 ml-1 inline" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
                </svg>
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
};

export default DirectChat; 