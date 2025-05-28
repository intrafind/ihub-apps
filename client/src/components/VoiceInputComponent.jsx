import React, { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import Icon from "./Icon";
import "./VoiceInput.css";
import AzureSpeechRecognition from "../utils/azureRecognitionService";
import VoiceFeedback from "./VoiceFeedback";

const VoiceInputComponent = ({
  app,
  onSpeechResult,
  inputRef,
  disabled = false,
  onCommand = null,
}) => {
  const { t, i18n } = useTranslation();
  const [isListening, setIsListening] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const feedbackRef = useRef(null);
  const recognitionRef = useRef(null);
  const originalInputValue = useRef("");

  // Clean up recognition when component unmounts
  useEffect(() => {
    return () => {
      stopListening();
    };
  }, []);

  // Handle keyboard shortcut
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "m") {
        e.preventDefault();
        toggleListening();
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  // Get command patterns for different languages
  const getCommandPatterns = () => {
    return {
      // Clear chat commands in various languages
      clearChat: [
        // English variations
        t("voiceCommands.clearChat", "clear chat"),
        "clear the chat",
        "delete chat",
        "delete all messages",
        "start new chat",
        "reset chat",
        // German variations
        t("voiceCommands.clearChat_de", "chat löschen"),
        "alles löschen",
        "nachrichten löschen",
        "neuer chat",
        "chat zurücksetzen",
        // Add other languages as needed
      ],

      // Send message commands in various languages
      sendMessage: [
        // English variations
        t("voiceCommands.sendMessage", "send message"),
        "send",
        "sent",
        "sent message",
        "submit message",
        "submit",
        // German variations
        t("voiceCommands.sendMessage_de", "nachricht senden"),
        "senden",
        "abschicken",
        "nachricht abschicken",
        // Add other languages as needed
      ],
    };
  };

  // Process speech for potential commands and return cleaned text and detected command
  const processSpeechForCommands = (text) => {
    if (!text) return { text, command: null };

    console.log("Processing speech for commands:", text);

    // Convert to lowercase for easier matching
    let lowerText = text.trim().replace(".", "").toLowerCase();
    let originalText = text.trim();
    let detectedCommand = null;

    // Get command patterns
    const commandPatterns = getCommandPatterns();
    console.log("Command patterns:", commandPatterns);

    // Check if the speech matches any command
    for (const [command, patterns] of Object.entries(commandPatterns)) {
      for (const pattern of patterns) {
        // Check if the text ends with the command pattern
        if (lowerText.endsWith(pattern)) {
          console.log(
            `Command detected: "${command}" with pattern: "${pattern}"`
          );
          // Remove the command from the text
          const commandIndex = lowerText.lastIndexOf(pattern);
          // Use the original text up to the command to preserve case
          originalText = originalText.substring(0, commandIndex).trim();
          detectedCommand = command;
          console.log(`Text after command removal: "${originalText}"`);
          return { text: originalText, command: detectedCommand };
        }
      }
    }

    console.log("No command detected in speech");
    return { text: originalText, command: null };
  };

  const startListening = async () => {
    if (disabled) return;

    try {
      // Check browser support
      if (
        !("webkitSpeechRecognition" in window) &&
        !("SpeechRecognition" in window)
      ) {
        showError(
          t(
            "voiceInput.error.notSupported",
            "Speech recognition not supported in this browser"
          )
        );
        return;
      }

      // Check microphone permission
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        stream.getTracks().forEach((track) => track.stop());
      } catch (err) {
        showError(
          t(
            "voiceInput.error.permissionDenied",
            "Please allow microphone access and try again."
          )
        );
        return;
      }

      // Store original input value to append to it later
      if (inputRef?.current) {
        originalInputValue.current = inputRef.current.value || "";
      }

      // Create recognition object
      const SpeechRecognition =
        window.SpeechRecognition || window.webkitSpeechRecognition;

      let recognition;

      switch (app?.settings?.speechRecognition?.service) {
        case "azure": {
          recognition = new AzureSpeechRecognition();
          recognition.host = app?.settings?.speechRecognition?.host;
          break;
        }
        case "default":
        default:
          recognition = new SpeechRecognition();
      }

      // Configure recognition
      recognition.continuous = false;
      recognition.interimResults = true;

      // Set language
      let recognitionLang = i18n.language;
      if (recognitionLang.length === 2) {
        const langMap = {
          en: "en-US",
          de: "de-DE",
          fr: "fr-FR",
          es: "es-ES",
          it: "it-IT",
          ja: "ja-JP",
          ko: "ko-KR",
          zh: "zh-CN",
          ru: "ru-RU",
          pt: "pt-BR",
          nl: "nl-NL",
          pl: "pl-PL",
          tr: "tr-TR",
          ar: "ar-SA",
        };
        recognitionLang = langMap[recognitionLang.toLowerCase()] || "en-US";
      }
      recognition.lang = recognitionLang;
      const isAzure = recognition instanceof AzureSpeechRecognition;

      if (isAzure) {
        recognition.initRecognizer();
      }

      // Set event handlers
      recognition.onstart = () => {
        setIsListening(true);
        if (inputRef?.current) {
          inputRef.current.placeholder = t(
            "voiceInput.listening",
            "Listening..."
          );
        }
      };

      recognition.onresult = (event) => {
        let interimTranscript = "";
        let finalTranscript = "";

        const result = "text" in event ? event.text : event.results;

        console.log("Speech recognition result received:", result);

        if (!isAzure) {
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const transcript = event.results[i][0].transcript;
            const isFinal = event.results[i].isFinal;

            console.log(
              `Transcript ${i}:`,
              transcript,
              isFinal ? "(final)" : "(interim)"
            );

            if (isFinal) {
              finalTranscript += transcript;
            } else {
              interimTranscript += transcript;
            }
          }
        } else {
          finalTranscript = event.text;
        }

        console.log("Final transcript:", finalTranscript);
        console.log("Interim transcript:", interimTranscript);

        // Process transcript for commands
        if (finalTranscript) {
          // Process for commands when we have a final result
          const { text: cleanText, command } =
            processSpeechForCommands(finalTranscript);
          console.log("After command processing:", { cleanText, command });

          // When we receive a final transcript with a command
          if (command && onCommand) {
            console.log("Command detected in final transcript:", command);

            // If there's clean text before the command, update the input field
            if (cleanText) {
              const newValue = cleanText;
              console.log("Using clean text for input:", newValue);

              // Update the input field
              if (inputRef?.current) {
                // Directly set value
                inputRef.current.value = newValue;

                // Update React state
                if (onSpeechResult) {
                  console.log(
                    "Calling onSpeechResult with clean text:",
                    newValue
                  );
                  onSpeechResult(newValue, true); // Pass true to indicate this is from a command
                }
              }
            }

            // Execute the command
            console.log("Executing command:", command);
            onCommand(command);
            stopListening();
            return;
          }

          // Normal text with no command
          const newValue = originalInputValue.current
            ? `${originalInputValue.current} ${finalTranscript}`.trim()
            : finalTranscript.trim();

          console.log("Setting final value with no command:", newValue);

          // Update input
          if (inputRef?.current) {
            inputRef.current.value = newValue;

            // Update React state
            if (onSpeechResult) {
              console.log("Calling onSpeechResult with:", newValue);
              onSpeechResult(newValue);
            }
          }

          return;
        }

        // Handle interim results
        if (interimTranscript) {
          // Just show interim results for feedback
          const interimDisplay = originalInputValue.current
            ? `${originalInputValue.current} ${interimTranscript}`.trim()
            : interimTranscript;

          // Update input field temporarily without calling setState
          if (inputRef?.current) {
            inputRef.current.value = interimDisplay;
          }
        }
      };

      recognition.onerror = (event) => {
        console.error("Speech recognition error:", event.error);
        let errorMsg = "";

        switch (event.error) {
          case "no-speech":
            errorMsg = t(
              "voiceInput.error.noSpeech",
              "No speech detected. Please try again."
            );
            break;
          case "audio-capture":
            errorMsg = t(
              "voiceInput.error.noMicrophone",
              "No microphone found. Please check your device settings."
            );
            break;
          case "not-allowed":
            errorMsg = t(
              "voiceInput.error.permissionDenied",
              "Please allow microphone access and try again."
            );
            break;
          case "network":
            errorMsg = t(
              "voiceInput.error.network",
              "Network error. Please check your connection."
            );
            break;
          default:
            errorMsg = t(
              "voiceInput.error.general",
              "Voice input error. Please try again."
            );
        }

        showError(errorMsg);
      };

      recognition.onend = () => {
        // Complete the recognition and update UI
        setIsListening(false);

        if (inputRef?.current) {
          inputRef.current.placeholder = t(
            "voiceInput.messagePlaceholder",
            "Type your message here..."
          );
        }

        // Clean up recognition object
        recognitionRef.current = null;
      };

      // Start recognition
      recognitionRef.current = recognition;
      recognition.start();
    } catch (error) {
      console.error("Error starting speech recognition:", error);
      showError(
        t(
          "voiceInput.error.startError",
          "Error starting voice input. Please try again."
        )
      );
      setIsListening(false);
    }
  };

  const stopListening = () => {
    // Stop the recognition if it's active
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (e) {
        console.error("Error stopping recognition:", e);
      }

      recognitionRef.current = null;
    }

    // Update UI
    setIsListening(false);

    if (inputRef?.current) {
      inputRef.current.placeholder = t(
        "voiceInput.messagePlaceholder",
        "Type your message here..."
      );
    }
  };

  const toggleListening = () => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  };

  const showError = (message) => {
    setErrorMessage(message);

    if (inputRef?.current) {
      inputRef.current.placeholder = message;

      // Reset placeholder after 3 seconds
      setTimeout(() => {
        if (inputRef?.current) {
          inputRef.current.placeholder = t(
            "voiceInput.messagePlaceholder",
            "Type your message here..."
          );
        }
      }, 3000);
    }
  };

  const handleOnFeedbackOverlayClose = () => {
    stopListening();
  };

  // Display errors in the UI
  useEffect(() => {
    if (errorMessage && inputRef?.current) {
      inputRef.current.placeholder = errorMessage;
    }
  }, [errorMessage]);

  return (
    <>
      <VoiceFeedback
        isActive={isListening}
        setIsActive={handleOnFeedbackOverlayClose}
      />
      <button
        className={`voice-input-button ${isListening ? "active" : ""} h-fit`}
        onClick={(e) => {
          e.preventDefault(); // Prevent any form submission
          toggleListening();
        }}
        type="button" // Explicitly set type to button to avoid form submission
        disabled={disabled}
        title={t("voiceInput.tooltip", "Voice input (Ctrl+M)")}
        aria-label={t("voiceInput.ariaLabel", "Toggle voice input")}
      >
        <Icon name="microphone" size="md" />
      </button>
    </>
  );
};

export default VoiceInputComponent;
