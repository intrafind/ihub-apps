import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  fetchAppDetails,
  fetchModels,
  fetchStyles,
  sendAppChatMessage,
  isTimeoutError,
  generateMagicPrompt,
} from "../api/api";
import AppConfigForm from "../components/AppConfigForm";
import LoadingSpinner from "../components/LoadingSpinner";
import { useTranslation } from "react-i18next";
import { getLocalizedContent } from "../utils/localizeContent";

// Import our custom hooks and components
import useEventSource from "../utils/useEventSource";
import useChatMessages from "../utils/useChatMessages";
import useVoiceCommands from "../utils/useVoiceCommands";
import ChatHeader from "../components/chat/ChatHeader";
import ChatInput from "../components/chat/ChatInput";
import ChatMessageList from "../components/chat/ChatMessageList";
import InputVariables from "../components/chat/InputVariables";
import { useUIConfig } from "../components/UIConfigContext";
import cache, { CACHE_KEYS } from "../utils/cache"; // Import cache for manual clearing
import { recordAppUsage } from "../utils/recentApps";

/**
 * Save app settings and variables to sessionStorage
 * @param {string} appId - The ID of the app
 * @param {Object} settings - Settings to save
 */
const saveAppSettings = (appId, settings) => {
  try {
    const key = `ai_hub_app_settings_${appId}`;
    sessionStorage.setItem(key, JSON.stringify(settings));
  } catch (error) {
    console.error("Error saving app settings to sessionStorage:", error);
  }
};

/**
 * Load app settings and variables from sessionStorage
 * @param {string} appId - The ID of the app
 * @returns {Object|null} The saved settings or null if not found
 */
const loadAppSettings = (appId) => {
  try {
    const key = `ai_hub_app_settings_${appId}`;
    const saved = sessionStorage.getItem(key);
    return saved ? JSON.parse(saved) : null;
  } catch (error) {
    console.error("Error loading app settings from sessionStorage:", error);
    return null;
  }
};

/**
 * Initialize variables with default values from app configuration
 * @param {Object} app - The app configuration
 * @param {string} currentLanguage - The current language
 * @returns {Object} - Object with initialized variables
 */
const getInitializedVariables = (app, currentLanguage) => {
  const initialVars = {};
  
  if (app && app.variables && Array.isArray(app.variables)) {
    app.variables.forEach((variable) => {
      // For select variables with predefined values, ensure we store the value, not the label
      if (variable.predefinedValues && variable.defaultValue) {
        // If defaultValue is an object with language keys
        if (typeof variable.defaultValue === "object") {
          const localizedLabel = getLocalizedContent(
            variable.defaultValue,
            currentLanguage
          );
          // Find the matching value for the localized label
          const matchingOption = variable.predefinedValues.find(
            (option) =>
              getLocalizedContent(option.label, currentLanguage) ===
              localizedLabel
          );
          // Use the value from predefined values if found, otherwise use the localized label
          initialVars[variable.name] = matchingOption
            ? matchingOption.value
            : localizedLabel;
        } else {
          // If defaultValue is a direct string, use it as is
          initialVars[variable.name] = variable.defaultValue;
        }
      } else if (variable.type === "select" && variable.options) {
        // For select variables, handle options with localization
        let matchingOption = null;
        // Try to find option that matches defaultValue
        if (variable.defaultValue) {
          matchingOption = variable.options.find(
            (option) => option.value === variable.defaultValue
          );
        }
        
        // Get localized label if available
        const localizedLabel =
          typeof variable.label === "object"
            ? getLocalizedContent(variable.label, currentLanguage)
            : variable.label || variable.name;
            
        // Use the value from predefined values if found, otherwise use the localized label
        initialVars[variable.name] = matchingOption
          ? matchingOption.value
          : localizedLabel;
      } else {
        // For other variables, use standard localization
        const localizedDefaultValue =
          typeof variable.defaultValue === "object"
            ? getLocalizedContent(variable.defaultValue, currentLanguage)
            : variable.defaultValue || "";
        initialVars[variable.name] = localizedDefaultValue;
      }
    });
  }
  
  return initialVars;
};

const AppChat = () => {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const { appId } = useParams();
  const navigate = useNavigate();
  const [app, setApp] = useState(null);
  const [models, setModels] = useState([]);
  const [styles, setStyles] = useState({});
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState(null);
  const [showConfig, setShowConfig] = useState(false);
  const [selectedModel, setSelectedModel] = useState(null);
  const [selectedStyle, setSelectedStyle] = useState("normal");
  const [selectedOutputFormat, setSelectedOutputFormat] = useState("markdown");
  const [sendChatHistory, setSendChatHistory] = useState(false);
  const [temperature, setTemperature] = useState(0.7);
  const [variables, setVariables] = useState({});
  const [showParameters, setShowParameters] = useState(true);
  const { setHeaderColor } = useUIConfig();

  // Record recent usage of this app
  useEffect(() => {
    recordAppUsage(appId);
  }, [appId]);
  
  // State for image upload and input configuration
  const [selectedImage, setSelectedImage] = useState(null);
  const [showImageUploader, setShowImageUploader] = useState(false);
  
  // State for file upload and input configuration
  const [selectedFile, setSelectedFile] = useState(null);
  const [showFileUploader, setShowFileUploader] = useState(false);
  const [originalInput, setOriginalInput] = useState(null);
  const [magicLoading, setMagicLoading] = useState(false);

  const inputRef = useRef(null);
  const chatId = useRef(`chat-${Date.now()}`);

  // Create a stable chat ID that persists across refreshes
  const [stableChatId] = useState(() => {
    // Use URL appId for consistency and stability
    const persistentId = `app-${appId}`;
    return persistentId;
  });

  // Use our custom chat messages hook for managing messages
  const {
    messages,
    addUserMessage,
    addAssistantMessage,
    updateAssistantMessage,
    setMessageError,
    deleteMessage,
    editMessage,
    addSystemMessage,
    clearMessages,
    getMessagesForApi,
  } = useChatMessages(stableChatId);

  // Use our custom event source hook for SSE connections
  const { initEventSource, cleanupEventSource, isConnected } = useEventSource({
    appId,
    chatId: chatId.current,
    onChunk: (fullContent) => {
      // Update the current assistant message with the new content
      if (window.lastMessageId) {
        updateAssistantMessage(window.lastMessageId, fullContent, true);
      }
    },
    onDone: (finalContent) => {
      // Mark the message as no longer loading
      if (window.lastMessageId) {
        updateAssistantMessage(window.lastMessageId, finalContent, false);
      }
    },
    onError: (error) => {
      // Update with an error message
      if (window.lastMessageId) {
        setMessageError(window.lastMessageId, error.message);
      }
    },
    onConnected: async (event) => {
      // Handle when connection is established
      try {
        if (window.pendingMessageData) {
          const { appId, chatId, messages, params } = window.pendingMessageData;

          console.log(
            "Connection established, sending pending message with parameters:",
            params
          );

          await sendAppChatMessage(appId, chatId, messages, params);

          // Clear the pending data after sending
          window.pendingMessageData = null;
        }
      } catch (error) {
        console.error("Error sending message on connection:", error);

        if (window.lastMessageId) {
          setMessageError(
            window.lastMessageId,
            t(
              "error.failedToGenerateResponse",
              "Error: Failed to generate response. Please try again or select a different model."
            )
          );
        }

        cleanupEventSource();
        setProcessing(false);
      }
    },
    onProcessingChange: setProcessing,
  });

  // Set up voice commands
  const { handleVoiceInput, handleVoiceCommand } = useVoiceCommands({
    messages,
    clearChat: () => {
      cleanupEventSource();
      clearMessages();
      chatId.current = `chat-${Date.now()}`;
      
      // Reset the chat input to empty
      setInput("");
      
      // Clear any selected image
      setSelectedImage(null);
      
      // Hide the image uploader if it's visible
      if (showImageUploader) {
        setShowImageUploader(false);
      }
      
      // Clear any selected file
      setSelectedFile(null);
      
      // Hide the file uploader if it's visible
      if (showFileUploader) {
        setShowFileUploader(false);
      }
      
      // Reset variables to their default values when clearing via voice command
      if (app && app.variables) {
        const initialVars = getInitializedVariables(app, currentLanguage);
        setVariables(initialVars);
        
        // Also update the saved settings with the reset variables
        const settings = {
          selectedModel,
          selectedStyle,
          selectedOutputFormat,
          sendChatHistory,
          temperature,
          variables: initialVars,
        };
        saveAppSettings(appId, settings);
      }
    },
    sendMessage: (text) => {
      setInput(text);
      setTimeout(() => {
        const form = document.querySelector("form");
        if (form) {
          const submitEvent = new Event("submit", {
            cancelable: true,
            bubbles: true,
          });
          form.dispatchEvent(submitEvent);
        }
      }, 0);
    },
    isProcessing: processing,
    currentText: input,
    setInput,
    onConfirmClear: () =>
      window.confirm(
        t(
          "pages.appChat.confirmClear",
          "Are you sure you want to clear the entire chat history?"
        )
      ),
  });

  // Reference to track if greeting has been added
  const greetingAddedRef = useRef(false);

  // Get UI config for fallback to widget greeting
  const { uiConfig } = useUIConfig();
  const widgetConfig = uiConfig?.widget || {};

  const hasVariablesToSend =
    app?.variables && Object.keys(variables).length > 0;

  useEffect(() => {
    // Store mounted state to prevent state updates after unmount
    let isMounted = true;

    const loadData = async () => {
      try {
        setLoading(true);

        // Add a small delay to allow i18n to fully initialize
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Only proceed if still mounted
        if (!isMounted) return;

        console.log("Fetching app data for:", appId);
        const appData = await fetchAppDetails(appId);
        
        // Safety check for component unmounting during async operations
        if (!isMounted) return;

        if (appData?.color) {
          setHeaderColor(appData.color);
        }

        // Batch related state updates
        const initialState = {
          app: appData,
          temperature: appData.preferredTemperature || 0.7,
          selectedStyle: appData.preferredStyle || "normal",
          selectedOutputFormat: appData.preferredOutputFormat || "markdown",
          sendChatHistory:
            appData.sendChatHistory !== undefined
              ? appData.sendChatHistory
              : false,
        };

        if (isMounted) {
          setApp(initialState.app);
          setTemperature(initialState.temperature);
          setSelectedStyle(initialState.selectedStyle);
          setSelectedOutputFormat(initialState.selectedOutputFormat);
          setSendChatHistory(initialState.sendChatHistory);
        }

        // Process variables if available
        if (appData.variables && isMounted) {
          const initialVars = getInitializedVariables(appData, currentLanguage);
          if (isMounted) {
            setVariables(initialVars);
          }
        }

        // Fetch models and styles in parallel to optimize loading
        const [modelsData, stylesData] = await Promise.all([
          fetchModels(),
          fetchStyles(),
        ]);

        // Exit if component unmounted during fetch
        if (!isMounted) return;

        // Determine model to select
        let modelToSelect = appData.preferredModel;
        if (appData.allowedModels && appData.allowedModels.length > 0) {
          if (!appData.allowedModels.includes(appData.preferredModel)) {
            modelToSelect = appData.allowedModels[0];
          }
        }

        if (isMounted) {
          setModels(modelsData);
          setStyles(stylesData);
          setSelectedModel(modelToSelect);
          setError(null);
        }
      } catch (err) {
        console.error("Error loading app data:", err);
        if (isMounted) {
          setError(
            t(
              "error.failedToLoadApp",
              "Failed to load application data. Please try again later."
            )
          );
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    loadData();

    // Cleanup function to handle component unmount
    return () => {
      isMounted = false;
    };
  }, [appId, currentLanguage, setHeaderColor]); // Remove t from dependencies

  // Load saved settings from sessionStorage when initializing
  useEffect(() => {
    if (app && !loading) {
      const savedSettings = loadAppSettings(appId);
      if (savedSettings) {
        // Restore settings if they exist
        if (savedSettings.selectedModel)
          setSelectedModel(savedSettings.selectedModel);
        if (savedSettings.selectedStyle)
          setSelectedStyle(savedSettings.selectedStyle);
        if (savedSettings.selectedOutputFormat)
          setSelectedOutputFormat(savedSettings.selectedOutputFormat);
        if (savedSettings.sendChatHistory !== undefined)
          setSendChatHistory(savedSettings.sendChatHistory);
        if (savedSettings.temperature)
          setTemperature(savedSettings.temperature);
        if (savedSettings.variables) setVariables(savedSettings.variables);

        console.log(
          "Restored app settings from sessionStorage:",
          savedSettings
        );
      }
    }
  }, [app, loading, appId]);

  // Save settings to sessionStorage whenever they change
  useEffect(() => {
    if (app && !loading) {
      const settings = {
        selectedModel,
        selectedStyle,
        selectedOutputFormat,
        sendChatHistory,
        temperature,
        variables,
      };

      saveAppSettings(appId, settings);
    }
  }, [
    app,
    loading,
    appId,
    selectedModel,
    selectedStyle,
    selectedOutputFormat,
    sendChatHistory,
    temperature,
    variables,
  ]);

  // Display greeting message when app is loaded and no messages exist yet.
  // Skip the greeting if starter prompts are configured so they can be shown
  useEffect(() => {
    // Only add greeting message when app is loaded, messages are empty,
    // no starter prompts exist, and we haven't added it yet
    if (
      app &&
      !loading &&
      messages.length === 0 &&
      !greetingAddedRef.current &&
      !(app.starterPrompts && app.starterPrompts.length > 0)
    ) {
      console.log("[AppChat] Adding greeting message when app loaded");

      // Check for language specific greeting
      const userLanguage = currentLanguage.split("-")[0].toLowerCase();

      // Try to get app-specific greeting first
      let greeting = null;

      // Check if app has its own greeting
      if (app.greeting) {
        greeting =
          typeof app.greeting === "object"
            ? app.greeting[userLanguage] || app.greeting.en
            : app.greeting;
      }

      // Fall back to widget greeting if app doesn't have one
      if (!greeting && widgetConfig.greeting) {
        greeting =
          widgetConfig.greeting[userLanguage] || widgetConfig.greeting.en;
      }

      // If we have a greeting, display it
      if (greeting) {
        // Create a greeting message and immediately mark it as not loading
        const greetingId = addAssistantMessage();
        updateAssistantMessage(greetingId, greeting, false);

        greetingAddedRef.current = true;
      }
    }

    // Reset the greeting flag when chat is cleared
    if (messages.length === 0) {
      greetingAddedRef.current = false;
    }
  }, [
    app,
    loading,
    messages.length,
    addAssistantMessage,
    updateAssistantMessage,
    currentLanguage,
    widgetConfig,
  ]);

  // Handle image selection from ImageUploader
  const handleImageSelect = (imageData) => {
    console.log('AppChat: handleImageSelect called with', imageData);
    setSelectedImage(imageData);
  };

  // Handle file selection from FileUploader
  const handleFileSelect = (fileData) => {
    console.log('AppChat: handleFileSelect called with', fileData);
    setSelectedFile(fileData);
  };

  // Toggle image uploader visibility
  const toggleImageUploader = () => {
    setShowImageUploader(prev => !prev);
  };

  // Toggle file uploader visibility
  const toggleFileUploader = () => {
    setShowFileUploader(prev => !prev);
  };

  const handleMagicPrompt = async () => {
    if (!input.trim()) return;
    try {
      setMagicLoading(true);
      const response = await generateMagicPrompt(input, {
        prompt: app?.features?.magicPrompt?.prompt,
        modelId: app?.features?.magicPrompt?.model,
        appId
      });
      if (response && response.prompt) {
        setOriginalInput(input);
        setInput(response.prompt);
      }
    } catch (err) {
      console.error('Error generating magic prompt:', err);
    } finally {
      setMagicLoading(false);
    }
  };

  const handleUndoMagicPrompt = () => {
    if (originalInput !== null) {
      setInput(originalInput);
      setOriginalInput(null);
    }
  };

  const handleInputChange = (e) => {
    setInput(e.target.value);
  };

  const handleStarterPromptClick = (prompt) => {
    setInput(prompt);
    if (inputRef.current) {
      inputRef.current.focus();
    }
  };

  const handleDeleteMessage = (messageId) => {
    deleteMessage(messageId);
  };

  const handleEditMessage = (messageId, newContent) => {
    editMessage(messageId, newContent);
  };

  const handleResendMessage = (messageId, editedContent) => {
    const messageToResend = messages.find((msg) => msg.id === messageId);
    if (!messageToResend) return;

    // Remove the selected message and any following messages to avoid sending
    // them again with the resent message
    deleteMessage(messageId);

    // Use the editedContent if provided directly from the ChatMessage component
    // otherwise use the content from the found message
    const contentToResend =
      editedContent !== undefined ? editedContent : messageToResend.content;

    // Set the input field to the current message content
    setInput(contentToResend);

    setTimeout(() => {
      const form = document.querySelector("form");
      if (form) {
        console.log("Submitting form with edited content:", contentToResend);
        const submitEvent = new Event("submit", {
          cancelable: true,
          bubbles: true,
        });
        form.dispatchEvent(submitEvent);
      }
    }, 0);
  };

  const clearChat = () => {
    if (
      window.confirm(
        t(
          "pages.appChat.confirmClear",
          "Are you sure you want to clear the entire chat history?"
        )
      )
    ) {
      cleanupEventSource();
      clearMessages();
      chatId.current = `chat-${Date.now()}`;
      
      // Reset the chat input to empty
      setInput("");
      
      // Clear any selected image
      setSelectedImage(null);
      
      // Hide the image uploader if it's visible
      if (showImageUploader) {
        setShowImageUploader(false);
      }
      
      // Clear any selected file
      setSelectedFile(null);
      
      // Hide the file uploader if it's visible
      if (showFileUploader) {
        setShowFileUploader(false);
      }
      
      // Reset variables to their default values
      if (app && app.variables) {
        const initialVars = getInitializedVariables(app, currentLanguage);
        setVariables(initialVars);
        
        // Also update the saved settings with the reset variables
        const settings = {
          selectedModel,
          selectedStyle,
          selectedOutputFormat,
          sendChatHistory,
          temperature,
          variables: initialVars,
        };
        saveAppSettings(appId, settings);
      }
    }
  };

  const cancelGeneration = useCallback(() => {
    cleanupEventSource();

    // Update the last message to indicate the generation was cancelled
    if (window.lastMessageId) {
      updateAssistantMessage(
        window.lastMessageId,
        messages.find((m) => m.id === window.lastMessageId)?.content +
          t("message.generationCancelled", " [Generation cancelled]"),
        false
      );
    }

    setProcessing(false);
  }, [cleanupEventSource, updateAssistantMessage, messages, t]);

  const handleSubmit = async (e) => {
    e.preventDefault();

    // Ensure input isn't empty before proceeding or we have an image or file
    if (!input.trim() && !selectedImage && !selectedFile && !app?.allowEmptyContent) {
      return;
    }

    // Check for required variables
    if (app?.variables) {
      const missingRequiredVars = app.variables
        .filter((v) => v.required)
        .filter((v) => !variables[v.name] || variables[v.name].trim() === "");

      if (missingRequiredVars.length > 0) {
        // Show inline error instead of using setError
        const errorMessage =
          t(
            "error.missingRequiredFields",
            "Please fill in all required fields:"
          ) +
          " " +
          missingRequiredVars
            .map((v) => getLocalizedContent(v.label, currentLanguage))
            .join(", ");

        addSystemMessage(errorMessage, true);

        // Highlight missing fields by scrolling to parameters section on mobile
        if (window.innerWidth < 768 && !showParameters) {
          toggleParameters();
        }

        return;
      }
    }

    // Prevent sending during active processing
    if (processing) {
      return;
    }

    // Calculate the final input, including image data or file data if available
    let finalInput = input.trim();
    let messageContent = finalInput;
    let messageData = null;

    // If we have an image, prepare it for display in the message
    if (selectedImage) {
      // For the message displayed to the user, create a simple display with text + image
      const imgPreview = `<img src="${selectedImage.base64}" alt="Uploaded image" style="max-width: 100%; max-height: 300px; margin-top: 8px;" />`;
      
      // If there's text, combine it with the image, otherwise just show the image
      messageContent = finalInput ? `${finalInput}\n\n${imgPreview}` : imgPreview;
      
      // Store the full image data for API transmission
      messageData = {
        imageData: selectedImage
      };
    }

    // If we have a file, prepare it for display in the message
    if (selectedFile) {
      // For the message displayed to the user, show only a simple file indicator
      const fileIndicator = `<div style="display: inline-flex; align-items: center; background-color: #4b5563; border: 1px solid #d1d5db; border-radius: 6px; padding: 4px 8px; margin-left: 8px; font-size: 0.875em; color: #ffffff;">
        <span style="margin-right: 4px;">📎</span>
        <span>${selectedFile.fileName}</span>
      </div>`;
      
      // If there's text, combine it with the file indicator, otherwise just show the file indicator
      messageContent = finalInput ? `${finalInput} ${fileIndicator}` : fileIndicator;
      
      // Store the full file data for API transmission
      messageData = {
        fileData: selectedFile
      };
    }

    try {
      cleanupEventSource();
      setProcessing(true);

      const originalUserInput = input;

      // Generate a single message ID for the entire exchange (request, response, and feedback)
      const exchangeId = `msg-${Date.now()}-${Math.floor(
        Math.random() * 1000
      )}`;
      console.log("Generated exchange ID:", exchangeId);

      // Create the user message
      addUserMessage(messageContent, {
        rawContent: originalUserInput,
        variables:
          app?.variables && app.variables.length > 0
            ? { ...variables }
            : undefined,
        ...messageData
      });

      setInput("");
      setOriginalInput(null);
      // Clear the selected image after sending
      setSelectedImage(null);
      // Close the image uploader
      setShowImageUploader(false);
      // Clear the selected file after sending
      setSelectedFile(null);
      // Close the file uploader
      setShowFileUploader(false);

      // Store the exchangeId in a window property for debugging
      window.lastMessageId = exchangeId;

      // Add assistant message placeholder
      addAssistantMessage(exchangeId);

      // Create message for the API
      const messageForAPI = {
        role: "user",
        content: originalUserInput,
        promptTemplate: app?.prompt || null,
        variables: { ...variables },
        messageId: exchangeId, // Send the exchangeId to the server
        imageData: selectedImage, // Include image data if available
        fileData: selectedFile // Include file data if available
      };

      // Get messages for the API
      const messagesForAPI = getMessagesForApi(sendChatHistory, messageForAPI);

      // Store the request parameters for use in the onConnected callback
      window.pendingMessageData = {
        appId,
        chatId: chatId.current,
        messages: messagesForAPI,
        params: {
          modelId: selectedModel,
          style: selectedStyle,
          temperature,
          outputFormat: selectedOutputFormat,
          language: currentLanguage,
        },
      };

      // Initialize event source - the actual message sending happens in the onConnected callback
      initEventSource(`/api/apps/${appId}/chat/${chatId.current}`);
    } catch (err) {
      console.error("Error sending message:", err);

      addSystemMessage(
        `Error: ${t("error.sendMessageFailed", "Failed to send message.")} ${
          err.message || t("error.tryAgain", "Please try again.")
        }`,
        true
      );

      setProcessing(false);
    }
  };

  // Function to clear app cache and reload
  const clearAppCache = useCallback(() => {
    // Clear all app detail caches
    cache.invalidateByPattern(CACHE_KEYS.APP_DETAILS);
    // Reload the current app
    window.location.reload();
  }, []);

  const toggleConfig = () => {
    setShowConfig(!showConfig);
  };

  const toggleParameters = () => {
    setShowParameters(!showParameters);
  };

  // Memoize localizedVariables calculation to prevent unnecessary work on every render
  const localizedVariables = useMemo(() => {
    if (!app?.variables || !Array.isArray(app.variables)) return [];

    return app.variables.map((variable) => ({
      ...variable,
      localizedLabel:
        getLocalizedContent(variable.label, currentLanguage) || variable.name,
      localizedDescription: getLocalizedContent(
        variable.description,
        currentLanguage
      ),
      localizedDefaultValue: getLocalizedContent(
        variable.defaultValue,
        currentLanguage
      ),
      localizedPlaceholder: getLocalizedContent(
        variable.placeholder,
        currentLanguage
      ),
      predefinedValues: variable.predefinedValues
        ? variable.predefinedValues.map((option) => ({
            ...option,
            localizedLabel:
              getLocalizedContent(option.label, currentLanguage) ||
              option.value,
          }))
        : undefined,
    }));
  }, [app?.variables, currentLanguage]);

  if (loading) {
    return <LoadingSpinner message={t("app.loading")} />;
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-screen">
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded-lg max-w-md">
          <p className="font-bold">
            {t("pages.appChat.errorTitle", "Error")}
          </p>
          <p>{error}</p>
          <button 
            onClick={clearAppCache}
            className="mt-3 bg-red-500 hover:bg-red-600 text-white font-bold py-2 px-4 rounded"
          >
            {t("pages.appChat.clearCache", "Clear Cache & Reload")}
          </button>
        </div>
      </div>
    );
  }

  // App icon
  const appIcon = (
    <svg
      className="w-6 h-6 text-white"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
      />
    </svg>
  );

  return (
    <div className="flex flex-col h-[calc(100vh-9rem)] max-h-[calc(100vh-9rem)] min-h-0 overflow-hidden pt-8">
      {/* App Header - using our reusable ChatHeader component */}
      <ChatHeader
        title={app?.name}
        description={app?.description}
        color={app?.color}
        icon={appIcon}
        showClearButton={messages.length > 0}
        showConfigButton={true}
        showParametersButton={
          app?.variables && app.variables.length > 0
        }
        onClearChat={clearChat}
        onToggleConfig={toggleConfig}
        onToggleParameters={toggleParameters}
        currentLanguage={currentLanguage}
        isMobile={window.innerWidth < 768}
        parametersVisible={showParameters}
      />

      {showConfig && (
        <div className="bg-gray-100 p-4 rounded-lg mb-4">
          <AppConfigForm
            app={app}
            models={models}
            styles={styles}
            selectedModel={selectedModel}
            selectedStyle={selectedStyle}
            selectedOutputFormat={selectedOutputFormat}
            sendChatHistory={sendChatHistory}
            temperature={temperature}
            onModelChange={setSelectedModel}
            onStyleChange={setSelectedStyle}
            onOutputFormatChange={setSelectedOutputFormat}
            onSendChatHistoryChange={setSendChatHistory}
            onTemperatureChange={setTemperature}
            currentLanguage={currentLanguage}
          />
        </div>
      )}

      {app?.variables && app.variables.length > 0 && showParameters && (
        <div className="md:hidden mb-4 p-4 bg-gray-50 rounded-lg overflow-y-auto max-h-[60vh]">
          <div className="flex justify-between items-center mb-3">
            <h3 className="font-medium">
              {t("pages.appChat.inputParameters")}
            </h3>
            <button
              onClick={toggleParameters}
              className="text-gray-500 hover:text-gray-700"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
          <InputVariables
            variables={variables}
            setVariables={setVariables}
            localizedVariables={localizedVariables}
          />
        </div>
      )}

      <div className="flex flex-col md:flex-row flex-1 gap-4 overflow-hidden mx-auto w-full max-w-7xl">
        <div
          className={`flex flex-col ${
            !app?.variables || app.variables.length === 0
              ? "max-w-6xl mx-auto w-full h-full"
              : "flex-1"
          }`}
        >
          {/* Chat Messages - using our reusable ChatMessageList component */}
          <ChatMessageList
            messages={messages}
            outputFormat={selectedOutputFormat}
            onDelete={handleDeleteMessage}
            onEdit={handleEditMessage}
            onResend={handleResendMessage}
            editable={true}
            appId={appId}
            chatId={chatId.current}
            modelId={selectedModel}
            starterPrompts={app?.starterPrompts || []}
            onSelectPrompt={handleStarterPromptClick}
          />

          {/* Message Input - using our reusable ChatInput component */}
          <ChatInput
            app={app}
            value={input}
            onChange={handleInputChange}
            onSubmit={handleSubmit}
            isProcessing={processing}
            onCancel={cancelGeneration}
            onVoiceInput={
              app?.microphone?.enabled !== false ? handleVoiceInput : undefined
            }
            onVoiceCommand={
              app?.microphone?.enabled !== false
                ? handleVoiceCommand
                : undefined
            }
            onImageSelect={handleImageSelect}
            imageUploadEnabled={app?.features?.imageUpload === true}
            onFileSelect={handleFileSelect}
            fileUploadEnabled={app?.features?.fileUpload === true}
            fileUploadConfig={app?.fileUpload || {}}
            allowEmptySubmit={app?.allowEmptyContent || selectedImage !== null || selectedFile !== null}
            inputRef={inputRef}
            selectedImage={selectedImage}
            showImageUploader={showImageUploader}
            onToggleImageUploader={toggleImageUploader}
            selectedFile={selectedFile}
            showFileUploader={showFileUploader}
            onToggleFileUploader={toggleFileUploader}
            magicPromptEnabled={app?.features?.magicPrompt?.enabled === true}
            onMagicPrompt={handleMagicPrompt}
            showUndoMagicPrompt={originalInput !== null}
            onUndoMagicPrompt={handleUndoMagicPrompt}
            magicPromptLoading={magicLoading}
          />
        </div>

        {app?.variables && app.variables.length > 0 && (
          <div className="hidden md:block w-80 lg:w-96 overflow-y-auto p-4 bg-gray-50 rounded-lg">
            <h3 className="font-medium mb-3">
              {t("pages.appChat.inputParameters")}
            </h3>
            <InputVariables
              variables={variables}
              setVariables={setVariables}
              localizedVariables={localizedVariables}
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default AppChat;
