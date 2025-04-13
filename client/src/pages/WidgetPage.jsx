import React, { useState, useEffect } from 'react';
import { useUIConfig } from '../components/UIConfigContext';
import ChatWidget from '../components/widget/ChatWidget';
import '../App.css';
import './WidgetPage.css';
import '../components/widget/ChatWidget.css';

/**
 * Standalone Widget Page that will be loaded in an iframe
 */
const WidgetPage = () => {
  // Get query parameters
  const params = new URLSearchParams(window.location.search);
  const appId = params.get('appId');
  const primaryColor = params.get('primaryColor');
  const language = params.get('language');
  const initialState = params.get('initialState') === 'open';
  const triggerElement = params.get('triggerElement');
  const autoOpenTrigger = params.get('autoOpenTrigger');
  const triggerOffset = parseInt(params.get('triggerOffset')) || 300;
  const position = params.get('position') || 'right';
  
  // Always set the widget to open when in iframe mode
  const [isOpen, setIsOpen] = useState(true);
  
  // Apply custom primary color if provided
  useEffect(() => {
    if (primaryColor) {
      document.documentElement.style.setProperty('--primary-color', decodeURIComponent(primaryColor));
    }
  }, [primaryColor]);
  
  // Debugging helper
  const debugLog = (message, data) => {
    console.log(`[Widget Frame] ${message}`, data || '');
  };
  
  // Log initial state
  useEffect(() => {
    debugLog('Widget mounted with initial state:', { 
      isOpen, 
      initialState, 
      appId, 
      triggerElement,
      autoOpenTrigger,
      triggerOffset,
      position
    });
  }, []);
  
  // Listen for messages from parent window
  useEffect(() => {
    const handleMessages = (event) => {
      // Handle actions from parent
      debugLog('Received message:', event.data);
      
      if (event.data && event.data.action) {
        const { action } = event.data;
        
        if (action === 'open') {
          debugLog('Opening widget');
          setIsOpen(true);
        } else if (action === 'close') {
          debugLog('Closing widget');
          setIsOpen(false);
        }
      }
    };
    
    window.addEventListener('message', handleMessages);
    return () => window.removeEventListener('message', handleMessages);
  }, []);
  
  // Log state changes
  useEffect(() => {
    debugLog('Widget state changed:', { isOpen });
  }, [isOpen]);
  
  // Handle close button click
  const handleClose = () => {
    debugLog('Close button clicked in widget');
    setIsOpen(false);
    
    // Notify parent window that widget was closed
    if (window.parent !== window) {
      debugLog('Notifying parent window of close');
      window.parent.postMessage({ type: 'widget-action', action: 'closed' }, '*');
    }
  };
  
  return (
    <div className={`widget-page ${isOpen ? 'open' : 'closed'}`}>
      <ChatWidget 
        forcedOpen={isOpen} 
        onClose={handleClose} 
        configuredAppId={appId}
        triggerElement={triggerElement}
        autoOpenTrigger={autoOpenTrigger}
        triggerOffset={triggerOffset}
        position={position}
      />
    </div>
  );
};

export default WidgetPage;