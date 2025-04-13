// Import CSS and i18n
import '../css/widget.css';
import i18n from './i18n.js';

class RAGChatWidget {
    constructor(options = {}) {
        this.options = {
            triggerElement: options.triggerElement || null,
            autoOpenTrigger: options.autoOpenTrigger || null,
            triggerOffset: options.triggerOffset || 300,
            position: options.position || 'right',
            width: options.width || '380px',
            height: options.height || '600px',
            ...options
        };
        
        this.isOpen = false;
        this.isInitialized = false;
        this.init();
    }

    init() {
        // Create widget container
        this.container = document.createElement('div');
        this.container.className = 'rag-chat-widget';
        this.container.style.display = 'none';
        
        // Create widget header
        this.header = document.createElement('div');
        this.header.className = 'widget-header';
        
        // Create toggle button
        this.toggleButton = document.createElement('button');
        this.toggleButton.className = 'widget-toggle';
        this.toggleButton.innerHTML = '<i class="fas fa-comments"></i>';
        
        // Create iframe container
        this.iframeContainer = document.createElement('div');
        this.iframeContainer.className = 'widget-iframe-container';
        
        // Create iframe
        this.iframe = document.createElement('iframe');
        this.iframe.className = 'widget-iframe';
        this.iframe.setAttribute('frameborder', '0');
        this.iframe.setAttribute('scrolling', 'no');
        
        // Assemble widget
        this.iframeContainer.appendChild(this.iframe);
        this.container.appendChild(this.toggleButton);
        this.container.appendChild(this.iframeContainer);
        document.body.appendChild(this.container);
        
        // Add event listeners
        this.toggleButton.addEventListener('click', async () => await this.toggle());
        window.addEventListener('scroll', () => this.checkTrigger());
        window.addEventListener('resize', () => this.checkTrigger());
        
        // Set initial state
        this.isInitialized = true;
        this.checkTrigger();
        
        // Load widget styles
        this.loadStyles();
    }

    loadStyles() {
        // Load Font Awesome
        if (!document.querySelector('link[href*="font-awesome"]')) {
            const fontAwesome = document.createElement('link');
            fontAwesome.rel = 'stylesheet';
            fontAwesome.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css';
            document.head.appendChild(fontAwesome);
        }

        // Widget styles are loaded via webpack CSS import
    }

    checkTrigger() {
        if (!this.isInitialized) return;

        // Function to check if an element is visible in viewport
        const isElementVisible = (selector) => {
            const element = document.querySelector(selector);
            if (element) {
                const rect = element.getBoundingClientRect();
                return rect.top >= 0 && rect.bottom <= window.innerHeight;
            }
            return false;
        };

        // Handle widget visibility trigger
        if (this.options.triggerElement) {
            const isVisible = isElementVisible(this.options.triggerElement);
            this.container.style.display = isVisible ? 'block' : 'none';
        } else {
            // Check scroll position
            const scrolled = window.scrollY || window.pageYOffset;
            if (scrolled > this.options.triggerOffset) {
                this.container.style.display = 'block';
            }
        }

        // Handle auto-open trigger
        if (this.options.autoOpenTrigger && !this.isOpen) {
            const isAutoTriggerVisible = isElementVisible(this.options.autoOpenTrigger);
            if (isAutoTriggerVisible) {
                this.open();
            }
        }
    }

    async toggle() {
        if (!this.isOpen) {
            this.open();
        } else {
            this.close();
        }
    }

    async open() {
        if (!this.isOpen) {
            this.isOpen = true;
            this.container.classList.add('open');
            
            // Initialize i18n if not already done
            if (!this.i18nInitialized) {
                await i18n.init();
                this.i18nInitialized = true;
            }

            // Load index.html in widget mode with current language
            const widgetMode = encodeURIComponent('widget');
            const currentLang = i18n.getCurrentLanguage();
            this.iframe.src = `index.html?mode=${widgetMode}&lang=${currentLang}`;
            
            // Add message listener for iframe communication
            window.addEventListener('message', this.handleMessage.bind(this));
        }
    }

    close() {
        if (this.isOpen) {
            this.isOpen = false;
            this.container.classList.remove('open');
            this.iframe.src = '';
            
            // Remove message listener
            window.removeEventListener('message', this.handleMessage.bind(this));
        }
    }

    handleMessage(event) {
        // Handle messages from iframe
        if (event.data.type === 'widget-height') {
            this.iframeContainer.style.height = `${event.data.height}px`;
        } else if (event.data.type === 'navigate') {
            // Update iframe src for navigation
            this.iframe.src = event.data.url;
        } else if (event.data.type === 'close-widget') {
            // Close the widget
            this.close();
        }
    }
}

// Export for both ES modules and global usage
if (typeof exports !== 'undefined') {
    exports.RAGChatWidget = RAGChatWidget;
} else {
    window.RAGChatWidget = RAGChatWidget;
}