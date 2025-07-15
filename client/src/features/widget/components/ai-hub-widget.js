/**
 * AI Hub Apps Chat Widget - Embed script
 * Version: 1.0.0
 *
 * This script allows embedding the AI Hub Apps Chat widget in any website
 */

(function () {
  // Configuration with default values
  let config = {
    appId: null,
    serverUrl: null, // Will default to the current domain if not provided
    position: 'right', // 'right' or 'left'
    primaryColor: null,
    language: 'en',
    initialState: 'closed' // 'open' or 'closed'
  };

  // For debugging
  let isDebugMode = true;

  function debug(...args) {
    if (isDebugMode) {
      console.log('[AI Hub Apps Widget]', ...args);
    }
  }

  // Create global aiHubWidget object
  window.aiHubWidget = {
    // Initialize widget with configuration
    init: function (userConfig) {
      // Merge user config with defaults
      if (userConfig) {
        config = { ...config, ...userConfig };
      }

      // Set default server URL if not provided
      if (!config.serverUrl) {
        // Default to same domain
        config.serverUrl = window.location.origin;
      }

      debug('Initializing widget with config:', config);

      // Create and add widget iframe
      createWidgetIframe();
    },

    // Open the widget
    open: function () {
      const iframe = document.getElementById('ai-hub-chat-widget-iframe');
      if (iframe) {
        debug('Sending open command to widget');
        iframe.contentWindow.postMessage({ action: 'open' }, '*');
      } else {
        debug('Error: Cannot find widget iframe');
      }
    },

    // Close the widget
    close: function () {
      const iframe = document.getElementById('ai-hub-chat-widget-iframe');
      if (iframe) {
        debug('Sending close command to widget');
        iframe.contentWindow.postMessage({ action: 'close' }, '*');
      } else {
        debug('Error: Cannot find widget iframe');
      }
    },

    // For debugging
    setDebug: function (enabled) {
      isDebugMode = enabled;
    }
  };

  // Create and add iframe to the page
  function createWidgetIframe() {
    // Create iframe element
    const iframe = document.createElement('iframe');
    iframe.id = 'ai-hub-chat-widget-iframe';
    iframe.title = 'AI Hub Chat Widget';
    iframe.style.position = 'fixed';
    iframe.style.bottom = '0';
    iframe.style.right = config.position === 'right' ? '0' : 'auto';
    iframe.style.left = config.position === 'left' ? '0' : 'auto';
    iframe.style.width = '100%';
    iframe.style.maxWidth = '380px';
    iframe.style.height = '600px';
    iframe.style.border = 'none';
    iframe.style.zIndex = '9999';
    iframe.style.overflow = 'hidden';
    iframe.style.transition = 'opacity 0.3s ease';

    // Build URL with query parameters for configuration
    const params = new URLSearchParams();
    if (config.appId) params.append('appId', config.appId);
    if (config.primaryColor) params.append('primaryColor', config.primaryColor);
    if (config.language) params.append('language', config.language);
    if (config.initialState === 'open') params.append('initialState', 'open');

    // Set iframe source
    const widgetUrl = `${config.serverUrl}/widget/chat?${params.toString()}`;
    iframe.src = widgetUrl;

    debug('Creating widget iframe with URL:', widgetUrl);

    // Append iframe to body
    document.body.appendChild(iframe);

    // Listen for messages from iframe
    window.addEventListener('message', handleWidgetMessages);
  }

  // Handle messages from the widget iframe
  function handleWidgetMessages(event) {
    // Check if the message is from our widget
    if (!event.data || typeof event.data !== 'object') return;

    debug('Received message from widget iframe:', event.data);

    // Handle resize events
    if (event.data.type === 'resize') {
      const iframe = document.getElementById('ai-hub-chat-widget-iframe');
      if (iframe && event.data.height) {
        iframe.style.height = `${event.data.height}px`;
      }
    }
  }
})();
