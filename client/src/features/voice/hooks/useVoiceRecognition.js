import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import AzureSpeechRecognition from '../../../utils/azureRecognitionService';
import VllmRealtimeRecognition from '../../../utils/vllmRealtimeRecognitionService';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';

const useVoiceRecognition = ({ app, inputRef, onSpeechResult, onCommand, disabled = false }) => {
  const { t, i18n } = useTranslation();
  const { platformConfig } = usePlatformConfig();
  const [isListening, setIsListening] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [transcript, setTranscript] = useState('');
  const recognitionRef = useRef(null);
  const originalInputValue = useRef('');
  const originalPlaceholder = useRef('');
  const errorTimeoutRef = useRef(null);

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
      if (errorTimeoutRef.current) {
        clearTimeout(errorTimeoutRef.current);
        errorTimeoutRef.current = null;
      }
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

  const clearError = useCallback(() => {
    if (errorTimeoutRef.current) {
      clearTimeout(errorTimeoutRef.current);
      errorTimeoutRef.current = null;
    }
    setErrorMessage('');
  }, []);

  const showError = message => {
    if (errorTimeoutRef.current) {
      clearTimeout(errorTimeoutRef.current);
    }
    setErrorMessage(message);
    if (inputRef?.current) {
      inputRef.current.placeholder = message;
    }
    // Auto-dismiss the error (both the overlay error state and the placeholder)
    // after a few seconds so it does not linger indefinitely.
    errorTimeoutRef.current = setTimeout(() => {
      errorTimeoutRef.current = null;
      setErrorMessage('');
      if (inputRef?.current) {
        inputRef.current.placeholder = originalPlaceholder.current;
      }
    }, 5000);
  };

  const startListening = async () => {
    if (disabled) return;

    clearError();

    try {
      const service = app?.settings?.speechRecognition?.service || 'default';

      // The browser Web Speech API is only required for the 'default' service.
      // Azure and the iHub-proxied vLLM realtime service capture audio directly
      // and don't depend on window.SpeechRecognition.
      if (
        service === 'default' &&
        !('webkitSpeechRecognition' in window) &&
        !('SpeechRecognition' in window)
      ) {
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

      switch (service) {
        case 'azure':
          recognition = new AzureSpeechRecognition();
          // Prefer the per-app host; fall back to the platform-level Azure host
          // configured in Admin → Voice Input (platform.speech.azure.host).
          recognition.host =
            app?.settings?.speechRecognition?.host || platformConfig?.speech?.azure?.host || '';
          break;
        case 'vllm-realtime':
          // Streams mic audio to iHub, which proxies to a vLLM realtime endpoint.
          // The endpoint is configured server-side, so no host is needed here.
          recognition = new VllmRealtimeRecognition();
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
      // Both the Azure service and the vLLM realtime service emit results as
      // { text, isFinal } objects rather than the browser SpeechRecognition
      // event shape. They mark themselves with `usesTextEventShape`.
      const usesTextEventShape = recognition.usesTextEventShape === true;

      if (recognition instanceof AzureSpeechRecognition) {
        // Async: fetches a short-lived Azure token from the server before
        // building the recognizer (the subscription key stays server-side).
        await recognition.initRecognizer();
      }

      // Some services (vLLM realtime) end asynchronously: after stop() the old
      // instance's final result / onend can arrive up to a few seconds later.
      // If the user restarted dictation in that window, those stale events must
      // not touch the CURRENT session's state or the input field.
      const isStale = () => recognitionRef.current && recognitionRef.current !== recognition;

      recognition.onstart = () => {
        if (isStale()) return;
        setIsListening(true);
        setTranscript('');
        if (inputRef?.current) {
          inputRef.current.placeholder = t('voiceInput.listening', 'Listening...');
        }
      };

      recognition.onresult = event => {
        if (isStale()) return;
        let interimTranscript = '';
        let finalTranscript = '';

        if (!usesTextEventShape) {
          // Browser SpeechRecognition API
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
          // Azure / vLLM realtime services emit { text, isFinal }
          if ('text' in event) {
            // Check if this is a final or interim result
            if (event.isFinal === false) {
              // Interim result from continuous recognition
              interimTranscript = event.text;
            } else {
              // Final result (from either recognizeOnceAsync or continuous recognition)
              finalTranscript = event.text;
            }
          }
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
        if (isStale()) return;
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
          case 'service':
            // Error surfaced by a proxied backend (e.g. the vLLM realtime
            // endpoint). Prefer the server-supplied message when available.
            errorMsg =
              event.message ||
              t('voiceInput.error.service', 'Transcription service unavailable. Please try again.');
            break;
          default:
            errorMsg = t('voiceInput.error.general', 'Voice input error. Please try again.');
        }
        showError(errorMsg);
      };

      recognition.onend = () => {
        // A late onend from a superseded instance must not tear down the new
        // session (it would null the ref and mark the UI idle while the new
        // session's mic is still hot).
        if (isStale()) return;
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
    errorMessage,
    clearError,
    toggleListening,
    stopListening,
    microphoneMode
  };
};

export default useVoiceRecognition;
