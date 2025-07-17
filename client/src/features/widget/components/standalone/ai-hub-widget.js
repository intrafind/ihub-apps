/**
 * AI Hub Apps Widget - Standalone embed script
 *
 * This script can be included on any website to embed the AI Hub Apps Chat Widget.
 * It creates a button and iframe container similar to the sample widget.js implementation.
 */

// Global namespace for widget
window.aiHubWidget = (function() {
  // Private variables
  let container = null;
  let toggleButton = null;
  let iframeContainer = null;
  let iframe = null;
  let isOpen = false;
  let isInitialized = false;
  let options = {
    serverUrl: window.location.origin,
    appId: 'faq-bot',
    position: 'right',
    primaryColor: 'rgb(0, 53, 87)',
    language: 'en',
    triggerElement: null,
    autoOpenTrigger: null,
    triggerOffset: 300
  };

  // Initialize the widget
  function init(userOptions = {}) {
    // Merge user options with defaults
    options = { ...options, ...userOptions };

    if (isInitialized) return;

    // Create widget container
    container = document.createElement('div');
    container.className = 'ai-hub-widget-container';

    // Set position based on options
    container.style.cssText = `
      position: fixed;
      bottom: 20px;
      ${options.position === 'left' ? 'left: 20px;' : 'right: 20px;'}
      z-index: 10000;
      display: none;
      overflow: hidden;
    `;

    // Create toggle button
    toggleButton = document.createElement('button');
    toggleButton.className = 'ai-hub-widget-toggle';
    toggleButton.innerHTML = '<i class="fas fa-comments"></i>';
    toggleButton.style.cssText = `
      width: 60px;
      height: 60px;
      border-radius: 50%;
      background-color: ${options.primaryColor};
      border: none;
      color: white;
      font-size: 24px;
      cursor: pointer;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
      transition: all 0.3s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 10px;
    `;

    // Create iframe container
    iframeContainer = document.createElement('div');
    iframeContainer.className = 'ai-hub-widget-iframe-container';
    iframeContainer.style.cssText = `
      display: none;
      width: 380px;
      height: 600px;
      background: white;
      border-radius: 10px;
      box-shadow: 0 5px 20px rgba(0, 0, 0, 0.2);
      overflow: hidden;
      transition: all 0.3s ease;
      position: relative;
    `;

    // Create iframe
    iframe = document.createElement('iframe');
    iframe.className = 'ai-hub-widget-iframe';
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('scrolling', 'no');
    iframe.style.cssText = `
      width: 100%;
      height: 100%;
      border: none;
      overflow: hidden;
    `;

    // Assemble widget
    iframeContainer.appendChild(iframe);
    container.appendChild(toggleButton);
    container.appendChild(iframeContainer);
    document.body.appendChild(container);

    // Add event listeners
    toggleButton.addEventListener('click', toggle);
    window.addEventListener('scroll', checkTrigger);
    window.addEventListener('resize', checkTrigger);
    window.addEventListener('message', handleMessage);

    // Load Font Awesome
    loadFontAwesome();

    // Set initial state
    isInitialized = true;
    checkTrigger();

    console.log('AI Hub Apps Widget initialized with options:', options);

    return {
      open: open,
      close: close,
      toggle: toggle
    };
  }

  // Load Font Awesome if not already loaded
  function loadFontAwesome() {
    if (!document.querySelector('link[href*="font-awesome"]')) {
      const fontAwesome = document.createElement('link');
      fontAwesome.rel = 'stylesheet';
      fontAwesome.href =
        'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css';
      document.head.appendChild(fontAwesome);
    }
  }

  // Check trigger conditions for widget visibility
  function checkTrigger() {
    if (!isInitialized) return;

    // Function to check if an element is visible in viewport
    const isElementVisible = selector => {
      if (!selector) return false;

      // Decode the selector if it's URL-encoded
      const decodedSelector = decodeURIComponent(selector);

      const element = document.querySelector(decodedSelector);
      if (element) {
        const rect = element.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= window.innerHeight;
      }
      return false;
    };

    // Check for trigger element visibility
    if (options.triggerElement) {
      const isVisible = isElementVisible(options.triggerElement);
      container.style.display = isVisible ? 'block' : 'none';
    } else {
      // Check scroll position if no trigger element
      const scrolled = window.scrollY || window.pageYOffset;
      container.style.display = scrolled > options.triggerOffset ? 'block' : 'none';
    }

    // Check auto-open trigger
    if (options.autoOpenTrigger && !isOpen) {
      const isAutoTriggerVisible = isElementVisible(options.autoOpenTrigger);
      if (isAutoTriggerVisible) {
        open();
      }
    }
  }

  // Toggle widget open/closed
  function toggle() {
    if (isOpen) {
      close();
    } else {
      open();
    }
  }

  // Open the widget
  function open() {
    if (!isInitialized) {
      init();
    }

    if (!isOpen) {
      isOpen = true;

      // Show iframe container
      iframeContainer.style.display = 'block';

      // Only load the URL if the iframe hasn't been loaded yet
      if (!iframe.src || iframe.src === 'about:blank') {
        // Build widget URL with parameters
        let widgetUrl = `${options.serverUrl}/widget/chat`;
        const params = new URLSearchParams();

        if (options.appId) params.append('appId', options.appId);
        if (options.primaryColor)
          params.append('primaryColor', encodeURIComponent(options.primaryColor));
        if (options.language) params.append('language', options.language);
        params.append('initialState', 'open');

        // Debug the iframe URL
        const finalUrl = `${widgetUrl}?${params.toString()}`;
        console.log('Loading widget iframe with URL:', finalUrl);

        // Load widget in iframe
        iframe.src = finalUrl;
      } else {
        // If iframe is already loaded, just notify it to open
        iframe.contentWindow.postMessage({ action: 'open' }, options.serverUrl);
      }

      // Add visual indication that the iframe is open
      toggleButton.innerHTML = '<i class="fas fa-times"></i>';

      console.log('AI Hub Apps Widget opened');
    }
  }

  // Close the widget
  function close() {
    if (isOpen) {
      isOpen = false;

      // Hide iframe container but don't unload it
      iframeContainer.style.display = 'none';

      // Notify iframe that widget is closed
      if (iframe.contentWindow) {
        iframe.contentWindow.postMessage({ action: 'close' }, options.serverUrl);
      }

      // Reset the toggle button icon to the chat icon
      toggleButton.innerHTML = '<i class="fas fa-comments"></i>';

      console.log('AI Hub Apps Widget closed');
    }
  }

  // Handle messages from iframe
  function handleMessage(event) {
    // Check origin for security
    if (event.origin !== options.serverUrl) {
      return;
    }

    const data = event.data;
    console.log('Message from widget iframe:', data);

    if (data && data.type === 'widget-action') {
      if (data.action === 'closed') {
        close();
      }
    }
  }

  // Public API
  return {
    init: init,
    open: function() {
      if (!isInitialized) {
        init();
      }
      open();
    },
    close: function() {
      if (isInitialized) {
        close();
      }
    },
    toggle: function() {
      if (!isInitialized) {
        init();
      }
      toggle();
    }
  };
})();
