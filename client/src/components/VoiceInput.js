export class VoiceInput {
    constructor(options = {}) {
        this.onStart = options.onStart || (() => {});
        this.onResult = options.onResult || (() => {});
        this.onEnd = options.onEnd || (() => {});
        this.onError = options.onError || (() => {});
        
        // Get language from options or default to browser language or fall back to en-US
        this.language = options.language || navigator.language || 'en-US';
        
        // Pause detection configuration
        this.pauseThreshold = options.pauseThreshold || 5000; // Default 2 seconds pause threshold
        this.autoRestart = options.autoRestart !== undefined ? options.autoRestart : true; // Auto restart when paused
        
        this.isListening = false;
        this.recognition = null;
        this.initialized = false;
        this.restartTimer = null;
        
        // Don't initialize immediately, wait for first use
        // This prevents unnecessary permission prompts
    }

    async initializeSpeechRecognition() {
        if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
            console.error('Speech recognition not supported');
            return;
        }

        // Check for microphone permission
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach(track => track.stop()); // Stop the stream after permission check
        } catch (err) {
            console.error('Microphone access error:', err);
            this.onError({ error: 'permission-denied' });
            return;
        }

        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        this.recognition = new SpeechRecognition();
        
        this.recognition.continuous = false; // Changed to false to prevent issues
        this.recognition.interimResults = true;
        
        // Set the recognition language based on the provided language option
        // Format the language for speech recognition (need full locale format like 'en-US')
        let recognitionLang = this.language;
        
        // If the language is just the language code (e.g., 'en' instead of 'en-US')
        if (recognitionLang.length === 2) {
            // Map language codes to common speech recognition locales
            const langMap = {
                'en': 'en-US',
                'de': 'de-DE',
                'fr': 'fr-FR',
                'es': 'es-ES',
                'it': 'it-IT',
                'ja': 'ja-JP',
                'ko': 'ko-KR',
                'zh': 'zh-CN',
                'ru': 'ru-RU',
                'pt': 'pt-BR',
                'nl': 'nl-NL',
                'pl': 'pl-PL',
                'tr': 'tr-TR',
                'ar': 'ar-SA'
            };
            recognitionLang = langMap[recognitionLang.toLowerCase()] || 'en-US';
        }
        
        console.log('Setting speech recognition language to:', recognitionLang);
        this.recognition.lang = recognitionLang;

        this.recognition.onstart = () => {
            this.isListening = true;
            this.onStart();
        };

        this.recognition.onresult = (event) => {
            let interimTranscript = '';
            let finalTranscript = '';

            for (let i = event.resultIndex; i < event.results.length; i++) {
                const transcript = event.results[i][0].transcript;
                if (event.results[i].isFinal) {
                    finalTranscript += transcript;
                } else {
                    interimTranscript += transcript;
                }
            }

            // When we get a result, clear any pending restart timer and set a new one
            if (this.restartTimer) {
                clearTimeout(this.restartTimer);
                this.restartTimer = null;
            }

            this.onResult({
                interim: interimTranscript,
                final: finalTranscript
            });
        };

        this.recognition.onerror = (event) => {
            console.error('Speech recognition error:', event.error);
            this.isListening = false;
            
            // Clear any pending restart timer
            if (this.restartTimer) {
                clearTimeout(this.restartTimer);
                this.restartTimer = null;
            }
            
            this.onError(event);
        };

        this.recognition.onend = () => {
            // If auto-restart is enabled and we're still in listening mode
            if (this.autoRestart && this.isListening) {
                console.log(`Speech recognition paused, will restart in ${this.pauseThreshold/1000} seconds if still in listening mode`);
                
                // Start timer to restart recognition
                this.restartTimer = setTimeout(() => {
                    if (this.isListening) {
                        console.log('Restarting speech recognition after pause');
                        this.start();
                    }
                }, this.pauseThreshold);
            }
            
            this.isListening = false;
            this.onEnd();
        };
    }

    async start() {
        if (!this.recognition) {
            await this.initializeSpeechRecognition();
            if (!this.recognition) {
                console.error('Speech recognition initialization failed');
                return;
            }
        }

        try {
            // Cleanup any existing restart timer
            if (this.restartTimer) {
                clearTimeout(this.restartTimer);
                this.restartTimer = null;
            }
            
            // Check if recognition is already started
            if (this.isListening) {
                this.recognition.stop();
                await new Promise(resolve => setTimeout(resolve, 100)); // Small delay
            }
            
            // Set internal flag to true before starting
            // This helps with the auto-restart logic
            this.isListening = true;
            
            // Start the recognition
            this.recognition.start();
            
            console.log('Speech recognition started');
        } catch (error) {
            console.error('Error starting speech recognition:', error);
            this.isListening = false;
            this.onError({ error: 'start-error', originalError: error });
        }
    }

    stop() {
        if (!this.recognition) return;
        
        // Set the internal flag to false first to prevent auto-restart
        this.isListening = false;
        
        // Clear any pending restart timer
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        
        try {
            this.recognition.stop();
        } catch (error) {
            console.error('Error stopping speech recognition:', error);
        }
    }

    toggle() {
        if (this.isListening) {
            this.stop();
        } else {
            this.start();
        }
    }
}

export function initializeVoiceInput(options = {}) {
    const {
        buttonId = 'voice-input-button',
        feedbackId = 'voice-feedback',
        inputId = 'user-input'
    } = options;

    const button = document.getElementById(buttonId);
    const feedback = document.getElementById(feedbackId);
    const input = document.getElementById(inputId);

    if (!button || !feedback || !input) {
        console.error('Required elements not found');
        return;
    }

    const voiceInput = new VoiceInput({
        onStart: () => {
            button.classList.add('active');
            feedback.classList.add('active');
            input.placeholder = 'Listening...';
        },
        onResult: (result) => {
            input.value = result.final + result.interim;
            input.style.height = 'auto';
            input.style.height = input.scrollHeight + 'px';
        },
        onEnd: () => {
            button.classList.remove('active');
            feedback.classList.remove('active');
            input.placeholder = 'Type your message here...';
        },
        onError: (error) => {
            console.error('Voice input error:', error);
            button.classList.remove('active');
            feedback.classList.remove('active');
            
            // Show specific error messages
            switch(error.error) {
                case 'permission-denied':
                    input.placeholder = 'Please allow microphone access and try again.';
                    break;
                case 'audio-capture':
                    input.placeholder = 'No microphone found. Please check your device settings.';
                    break;
                case 'network':
                    input.placeholder = 'Network error. Please check your connection.';
                    break;
                case 'no-speech':
                    input.placeholder = 'No speech detected. Please try again.';
                    break;
                case 'start-error':
                    input.placeholder = 'Error starting voice input. Please try again.';
                    break;
                default:
                    input.placeholder = 'Voice input error. Please try again.';
            }
            
            // Reset placeholder after 3 seconds
            setTimeout(() => {
                input.placeholder = 'Type your message here...';
            }, 3000);
        }
    });

    // Click handler
    button.addEventListener('click', () => {
        voiceInput.toggle();
    });

    // Keyboard shortcut (Ctrl+M)
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'm') {
            e.preventDefault();
            voiceInput.toggle();
        }
    });

    return voiceInput;
}