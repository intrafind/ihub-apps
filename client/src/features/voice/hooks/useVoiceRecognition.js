import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import AzureSpeechRecognition from '../../../utils/azureRecognitionService';

const useVoiceRecognition = ({ app, inputRef, onSpeechResult, onCommand, disabled = false }) => {
  const { t, i18n } = useTranslation();
  const [isListening, setIsListening] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [transcript, setTranscript] = useState('');
  const recognitionRef = useRef(null);
  const originalInputValue = useRef('');
  const originalPlaceholder = useRef('');

  const microphoneMode = app?.inputMode?.microphone?.mode || app?.microphone?.mode || 'automatic';

  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (e) {
        console.error('Error stopping recognition:', e);
      }
      recognitionRef.current = null;
    }
    setIsListening(false);
    setTranscript('');
    if (inputRef?.current) {
      inputRef.current.placeholder = originalPlaceholder.current;
    }
  }, [inputRef]);

  useEffect(() => {
    return () => {
      stopListening();
    };
  }, [stopListening]);

  useEffect(() => {
    if (errorMessage && inputRef?.current) {
      inputRef.current.placeholder = errorMessage;
    }
  }, [errorMessage, inputRef]);

  const getCommandPatterns = () => {
    return {
      clearChat: [
        t('voiceCommands.clearChat', 'clear chat'),
        'clear the chat',
        'delete chat',
        'delete all messages',
        'start new chat',
        'reset chat',
        t('voiceCommands.clearChat_de', 'chat löschen'),
        'alles löschen',
        'nachrichten löschen',
        'neuer chat',
        'chat zurücksetzen'
      ],
      sendMessage: [
        t('voiceCommands.sendMessage', 'send message'),
        'send',
        'sent',
        'sent message',
        'submit message',
        'submit',
        t('voiceCommands.sendMessage_de', 'nachricht senden'),
        'senden',
        'abschicken',
        'nachricht abschicken'
      ]
    };
  };

  const processSpeechForCommands = text => {
    if (!text) return { text, command: null };

    let lowerText = text.trim().replace('.', '').toLowerCase();
    let originalText = text.trim();
    let detectedCommand = null;

    const commandPatterns = getCommandPatterns();

    for (const [command, patterns] of Object.entries(commandPatterns)) {
      for (const pattern of patterns) {
        if (lowerText.endsWith(pattern)) {
          const commandIndex = lowerText.lastIndexOf(pattern);
          originalText = originalText.substring(0, commandIndex).trim();
          detectedCommand = command;
          return { text: originalText, command: detectedCommand };
        }
      }
    }

    return { text: originalText, command: null };
  };

  const showError = message => {
    setErrorMessage(message);
    if (inputRef?.current) {
      inputRef.current.placeholder = message;
      setTimeout(() => {
        if (inputRef?.current) {
          inputRef.current.placeholder = originalPlaceholder.current;
        }
      }, 3000);
    }
  };

  const startListening = async () => {
    if (disabled) return;

    try {
      if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
        showError(
          t('voiceInput.error.notSupported', 'Speech recognition not supported in this browser')
        );
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(track => track.stop());
      } catch {
        showError(
          t('voiceInput.error.permissionDenied', 'Please allow microphone access and try again.')
        );
        return;
      }

      if (inputRef?.current) {
        originalInputValue.current = inputRef.current.value || '';
        originalPlaceholder.current = inputRef.current.placeholder || '';
      }

      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      let recognition;

      switch (app?.settings?.speechRecognition?.service) {
        case 'azure':
          recognition = new AzureSpeechRecognition();
          recognition.host = app?.settings?.speechRecognition?.host;
          break;
        case 'default':
        default:
          recognition = new SpeechRecognition();
      }

      recognition.continuous = microphoneMode === 'manual';
      recognition.interimResults = true;

      let recognitionLang = i18n.language;
      if (recognitionLang.length === 2) {
        const langMap = {
          en: 'en-US',
          de: 'de-DE',
          fr: 'fr-FR',
          es: 'es-ES',
          it: 'it-IT',
          ja: 'ja-JP',
          ko: 'ko-KR',
          zh: 'zh-CN',
          ru: 'ru-RU',
          pt: 'pt-BR',
          nl: 'nl-NL',
          pl: 'pl-PL',
          tr: 'tr-TR',
          ar: 'ar-SA'
        };
        recognitionLang = langMap[recognitionLang.toLowerCase()] || 'en-US';
      }
      recognition.lang = recognitionLang;
      const isAzure = recognition instanceof AzureSpeechRecognition;

      if (isAzure) {
        recognition.initRecognizer();
      }

      recognition.onstart = () => {
        setIsListening(true);
        setTranscript('');
        if (inputRef?.current) {
          inputRef.current.placeholder = t('voiceInput.listening', 'Listening...');
        }
      };

      recognition.onresult = event => {
        let interimTranscript = '';
        let finalTranscript = '';

        'text' in event ? event.text : event.results;

        if (!isAzure) {
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const transcript = event.results[i][0].transcript;
            const isFinal = event.results[i].isFinal;
            if (isFinal) {
              finalTranscript += transcript;
            } else {
              interimTranscript += transcript;
            }
          }
        } else {
          finalTranscript = event.text;
        }

        setTranscript(interimTranscript || finalTranscript);

        if (finalTranscript) {
          const { text: cleanText, command } = processSpeechForCommands(finalTranscript);

          if (command && onCommand) {
            if (cleanText) {
              const newValue = cleanText;
              if (inputRef?.current) {
                inputRef.current.value = newValue;
                if (onSpeechResult) {
                  onSpeechResult(newValue, true);
                }
              }
            }

            onCommand(command);
            stopListening();
            return;
          }

          const newValue = originalInputValue.current
            ? `${originalInputValue.current} ${finalTranscript}`.trim()
            : finalTranscript.trim();

          if (inputRef?.current) {
            inputRef.current.value = newValue;
            if (onSpeechResult) {
              onSpeechResult(newValue);
            }
            originalInputValue.current = newValue;
          }
        }

        if (interimTranscript) {
          const interimDisplay = originalInputValue.current
            ? `${originalInputValue.current} ${interimTranscript}`.trim()
            : interimTranscript;
          if (inputRef?.current) {
            inputRef.current.value = interimDisplay;
          }
        }
      };

      recognition.onerror = event => {
        let errorMsg = '';
        switch (event.error) {
          case 'no-speech':
            errorMsg = t('voiceInput.error.noSpeech', 'No speech detected. Please try again.');
            break;
          case 'audio-capture':
            errorMsg = t(
              'voiceInput.error.noMicrophone',
              'No microphone found. Please check your device settings.'
            );
            break;
          case 'not-allowed':
            errorMsg = t(
              'voiceInput.error.permissionDenied',
              'Please allow microphone access and try again.'
            );
            break;
          case 'network':
            errorMsg = t(
              'voiceInput.error.network',
              'Network error. Please check your connection.'
            );
            break;
          default:
            errorMsg = t('voiceInput.error.general', 'Voice input error. Please try again.');
        }
        showError(errorMsg);
      };

      recognition.onend = () => {
        setIsListening(false);
        setTranscript('');
        if (inputRef?.current) {
          inputRef.current.placeholder = originalPlaceholder.current;
        }
        recognitionRef.current = null;
      };

      recognitionRef.current = recognition;
      recognition.start();
    } catch (error) {
      console.error('Error starting speech recognition:', error);
      showError(t('voiceInput.error.startError', 'Error starting voice input. Please try again.'));
      setIsListening(false);
    }
  };

  const toggleListening = () => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  };

  return {
    isListening,
    transcript,
    toggleListening,
    stopListening,
    microphoneMode
  };
};

export default useVoiceRecognition;
