import { useCallback, useRef } from 'react';

/**
 * Custom hook for handling voice commands in chat applications
 * 
 * @param {Object} options - Configuration options
 * @param {Array} options.messages - Current chat messages
 * @param {Function} options.clearChat - Function to clear chat history
 * @param {Function} options.sendMessage - Function to send a message
 * @param {boolean} options.isProcessing - Whether a message is currently being processed
 * @param {string} options.currentText - Current text in the input field
 * @param {Function} options.onConfirmClear - Custom confirmation callback for clear chat
 * @returns {Object} Voice command handler functions
 */
function useVoiceCommands({
  messages,
  clearChat,
  sendMessage,
  isProcessing,
  currentText,
  onConfirmClear
}) {
  // Store the latest recognized text in a ref for immediate access outside React's state system
  const currentVoiceTextRef = useRef('');

  /**
   * Update the current voice text
   * @param {string} text - The recognized text
   * @param {boolean} isCommand - Whether this was triggered by a command
   */
  const handleVoiceInput = useCallback((text, isCommand = false) => {
    // Store the clean text in a ref for immediate access
    if (isCommand) {
      currentVoiceTextRef.current = text;
    }
    
    return text;
  }, []);

  /**
   * Handle voice commands
   * @param {string} command - The detected command
   */
  const handleVoiceCommand = useCallback((command) => {
    console.log('Voice command detected:', command);
    
    switch (command) {
      case 'clearChat':
        // Clear the chat after confirming with the user
        if (messages.length > 0) {
          const shouldClear = onConfirmClear 
            ? onConfirmClear() 
            : window.confirm('Are you sure you want to clear the entire chat history?');
            
          if (shouldClear) {
            clearChat();
          }
        }
        break;
        
      case 'sendMessage':
        // Use the currentVoiceTextRef to get the latest voice text
        const messageToSend = currentVoiceTextRef.current || currentText;
        console.log('Executing send message command with text:', messageToSend);
        
        if (messageToSend.trim() && !isProcessing) {
          sendMessage(messageToSend);
        } else {
          console.log('No text to send or processing in progress');
        }
        break;
        
      default:
        console.log('Unknown command:', command);
    }
  }, [messages, clearChat, sendMessage, isProcessing, currentText, onConfirmClear]);

  return {
    handleVoiceInput,
    handleVoiceCommand,
    currentVoiceTextRef
  };
}

export default useVoiceCommands;