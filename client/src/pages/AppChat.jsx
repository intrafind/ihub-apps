import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
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
import Icon from "../components/Icon";

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

/**
 * Component for displaying starter prompts
 */
const StarterPromptsView = ({ starterPrompts, onSelectPrompt }) => {
  const { t, i18n } = useTranslation();

  return (
    <div className="text-center text-gray-500 space-y-6 w-full">
      <div className="space-y-2">
        <svg
          className="w-12 h-12 mx-auto mb-3 text-indigo-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
          />
        </svg>
        <h3 className="text-xl font-semibold text-gray-700 mb-1">
          {t('pages.appChat.starterPromptsTitle', 'Starter Prompts')}
        </h3>
        <p className="text-sm text-gray-500 max-w-md mx-auto md:px-4">
          {t('pages.appChat.starterPromptsSubtitle', 'Choose a prompt below to get started quickly')}
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 w-full max-w-4xl mx-auto px-4 pb-4">
        {starterPrompts.map((sp, idx) => (
          <button
            key={idx}
            type="button"
            className="group relative p-4 text-left bg-white border border-gray-200 rounded-xl shadow-sm hover:shadow-md hover:border-indigo-300 transition-all duration-200 transform hover:-translate-y-0.5 h-full min-h-[100px] flex flex-col"
            onClick={() =>
              onSelectPrompt &&
              onSelectPrompt({
                ...sp,
                message: getLocalizedContent(sp.message, i18n.language),
              })
            }
          >
            <div className="flex items-start space-x-3 h-full">
              <div className="flex-shrink-0 w-8 h-8 bg-indigo-100 rounded-lg flex items-center justify-center group-hover:bg-indigo-200 transition-colors mt-0.5">
                <svg
                  className="w-4 h-4 text-indigo-600"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M13 10V3L4 14h7v7l9-11h-7z"
                  />
                </svg>
              </div>
              <div className="flex-1 min-w-0 flex flex-col justify-start">
                <p className="font-semibold text-gray-900 text-sm leading-5 mb-1">
                  {getLocalizedContent(sp.title, i18n.language)}
                </p>
                <p className="text-xs text-gray-500 leading-4 overflow-hidden" style={{
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical'
                }}>
                  {getLocalizedContent(sp.message, i18n.language)}
                </p>
              </div>
            </div>
            <div className="absolute inset-0 rounded-xl border border-transparent group-hover:border-indigo-200 transition-colors pointer-events-none"></div>
          </button>
        ))}
      </div>
    </div>
  );
};

/**
 * Component for displaying greeting message
 */
const GreetingView = ({ welcomeMessage }) => {
  const { t } = useTranslation();

  // Handle both old string format and new title/subtitle object format
  let title, subtitle;
  
  if (typeof welcomeMessage === 'object' && welcomeMessage !== null) {
    // New format with title and subtitle
    title = welcomeMessage.title || '';
    subtitle = welcomeMessage.subtitle || '';
  } else if (typeof welcomeMessage === 'string') {
    // Legacy format - use the string as title
    title = welcomeMessage;
    subtitle = t('pages.appChat.noMessagesSubtitle', 'Start a conversation by sending a message!');
  } else {
    // Fallback
    title = t('pages.appChat.noMessagesTitle', 'Welcome!');
    subtitle = t('pages.appChat.noMessagesSubtitle', 'Start a conversation by sending a message!');
  }

  return (
    <div className="text-center text-gray-500 space-y-6 w-full">
      <div className="px-4">
        <Icon name="chat-bubble" size="3xl" className="mx-auto mb-4 text-gray-400" />
        <h3 className="text-lg font-semibold mb-2">
          {title}
        </h3>
        <p className="text-sm max-w-md mx-auto">
          {subtitle}
        </p>
      </div>
    </div>
  );
};

/**
 * Component for displaying no messages state
 */
const NoMessagesView = () => {
  const { t } = useTranslation();

  return (
    <div className="text-center text-gray-500 space-y-6 w-full">
      <div className="px-4">
        <Icon name="chat-bubble" size="3xl" className="mx-auto mb-4 text-gray-400" />
        <h3 className="text-lg font-semibold mb-2">
          {t('pages.appChat.noMessagesTitle', 'No Messages Yet')}
        </h3>
        <p className="text-sm max-w-md mx-auto">
          {t('pages.appChat.noMessagesSubtitle', 'Start a conversation by sending a message!')}
        </p>
      </div>
    </div>
  );
};

/**
 * Renders the appropriate startup state component
 */
const renderStartupState = (app, welcomeMessage, handleStarterPromptClick) => {
  const starterPrompts = app?.starterPrompts || [];
  
  if (starterPrompts.length > 0) {
    return <StarterPromptsView starterPrompts={starterPrompts} onSelectPrompt={handleStarterPromptClick} />;
  } else if (welcomeMessage) {
    return <GreetingView welcomeMessage={welcomeMessage} />;
  } else {
    return <NoMessagesView />;
  }
};

const AppChat = () => {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const { appId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const prefillMessage = searchParams.get('prefill') || "";
  const [app, setApp] = useState(null);
  const [models, setModels] = useState([]);
  const [styles, setStyles] = useState({});
  const [input, setInput] = useState(prefillMessage);
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
  const [showParameters, setShowParameters] = useState(false);
  const { setHeaderColor } = useUIConfig();

  const [maxTokens, setMaxTokens] = useState(null);
  const [useMaxTokens, setUseMaxTokens] = useState(false);

  // State for managing parameter changes on mobile
  const [tempVariables, setTempVariables] = useState({});
  const [parametersChanged, setParametersChanged] = useState(false);

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
    onDone: (finalContent, info) => {
      // Mark the message as no longer loading
      if (window.lastMessageId) {
        updateAssistantMessage(window.lastMessageId, finalContent, false, {
          finishReason: info.finishReason,
        });
      }
      setUseMaxTokens(false);
    },
    onError: (error) => {
      // Update with an error message
      if (window.lastMessageId) {
        setMessageError(window.lastMessageId, error.message);
      }
      setUseMaxTokens(false);
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
        if (isMounted) {
          setMaxTokens(appData.tokenLimit || 4096);
        }
        
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

  // Calculate the welcome message to display (if any) - show greeting when configured
  const welcomeMessage = useMemo(() => {
    // Don't show welcome message if there are any messages
    if (!app || loading || messages.length > 0) return null;
    
    // Skip if starter prompts are configured - they take priority
    if (app.starterPrompts && app.starterPrompts.length > 0) {
      return null;
    }

    // Get the greeting message if configured
    const userLanguage = currentLanguage.split("-")[0].toLowerCase();
    
    let greeting = null;
    
    // Check if app has its own greeting
    if (app.greeting) {
      greeting =
        typeof app.greeting === "object"
          ? app.greeting[userLanguage] || app.greeting.en
          : app.greeting;
    }

    return greeting;
  }, [app, loading, currentLanguage, messages.length, widgetConfig]);

  // Determine if input should be centered (only when showing example prompts)
  const shouldCenterInput = useMemo(() => {
    if (!app || loading || messages.length > 0) return false;
    
    return true;
  }, [app, loading, messages.length, welcomeMessage]);

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
    if (prompt && typeof prompt === "object") {
      if (prompt.message) {
        setInput(prompt.message);
      }
      if (prompt.variables) {
        setVariables((prev) => ({ ...prev, ...prompt.variables }));
      }
    } else {
      setInput(prompt);
    }
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

  const handleResendMessage = (messageId, editedContent, useMaxTokens = false) => {
    const messageToResend = messages.find((msg) => msg.id === messageId);
    if (!messageToResend) return;

    let contentToResend = editedContent;

    if (messageToResend.role === 'assistant') {
      const idx = messages.findIndex((msg) => msg.id === messageId);
      const prevUser = [...messages.slice(0, idx)].reverse().find((m) => m.role === 'user');
      if (!prevUser) return;
      contentToResend = prevUser.rawContent || prevUser.content;
      // remove the user message and everything after it, including the assistant reply
      deleteMessage(prevUser.id);
    } else {
      deleteMessage(messageId);
      if (contentToResend === undefined) {
        contentToResend = messageToResend.rawContent || messageToResend.content;
      }
    }

    setInput(contentToResend);
    if (useMaxTokens) {
      setUseMaxTokens(true);
    }

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
          ...(useMaxTokens ? { useMaxTokens: true } : {}),
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
    if (window.innerWidth < 768) {
      // On mobile, prepare temp variables when opening
      if (!showParameters) {
        setTempVariables({ ...variables });
        setParametersChanged(false);
      }
    }
    setShowParameters(!showParameters);
  };

  const handleParametersOk = () => {
    // Apply temp variables to actual variables
    setVariables({ ...tempVariables });
    setShowParameters(false);
    setParametersChanged(false);
  };

  const handleParametersCancel = () => {
    // Discard changes and close modal
    setTempVariables({});
    setShowParameters(false);
    setParametersChanged(false);
  };

  const handleTempVariableChange = (newVariables) => {
    setTempVariables(newVariables);
    setParametersChanged(true);
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

  // Initialize temp variables when variables change
  useEffect(() => {
    if (!showParameters) {
      setTempVariables({ ...variables });
    }
  }, [variables, showParameters]);

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
    <div className="flex flex-col h-[calc(100vh-10rem)] max-h-[calc(100vh-10rem)] min-h-0 overflow-hidden pt-4 pb-2">
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
        <div 
          className="md:hidden fixed inset-0 bg-black bg-opacity-50 z-50 flex items-end"
          onClick={(e) => {
            // Close modal when clicking backdrop
            if (e.target === e.currentTarget) {
              handleParametersCancel();
            }
          }}
        >
          <div className="w-full bg-white rounded-t-lg max-h-[85vh] overflow-hidden flex flex-col">
            <div className="flex justify-between items-center p-4 border-b flex-shrink-0">
              <h3 className="font-medium">
                {t("pages.appChat.inputParameters")}
              </h3>
              <button
                onClick={handleParametersCancel}
                className="text-gray-500 hover:text-gray-700 p-1"
              >
                <svg
                  className="w-6 h-6"
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
            <div className="p-4 overflow-y-auto flex-1">
              <InputVariables
                variables={tempVariables}
                setVariables={handleTempVariableChange}
                localizedVariables={localizedVariables}
              />
            </div>
            <div className="flex gap-3 p-4 border-t bg-gray-50 flex-shrink-0">
              <button
                onClick={handleParametersCancel}
                className="flex-1 px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 font-medium"
              >
                {t("common.cancel", "Cancel")}
              </button>
              <button
                onClick={handleParametersOk}
                className="flex-1 px-4 py-2 text-white bg-blue-600 rounded-lg hover:bg-blue-700 font-medium"
              >
                {t("common.ok", "OK")}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-col md:flex-row flex-1 gap-4 overflow-hidden mx-auto w-full">
        <div className="flex flex-col max-w-6xl mx-auto w-full h-full">
          {shouldCenterInput ? (
            /* Centered layout for example prompts */
            <>
              {/* Mobile layout: content centers, input at bottom */}
              <div className="flex flex-col h-full md:hidden">
                <div className="flex-1 overflow-hidden">
                  {messages.length > 0 ? (
                    <div className="w-full h-full overflow-y-auto bg-gray-50 rounded-lg">
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
                      />
                    </div>
                  ) : (
                    <div className="w-full h-full overflow-y-auto">
                      <div className="min-h-full flex items-center justify-center p-4">
                        <div className="w-full max-w-4xl">
                          {renderStartupState(app, welcomeMessage, handleStarterPromptClick)}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex-shrink-0 px-4 pt-2">
                  <div className="w-full max-w-4xl mx-auto">
                    <ChatInput
                      app={app}
                      value={input}
                      onChange={handleInputChange}
                      onSubmit={handleSubmit}
                      isProcessing={processing}
                      onCancel={cancelGeneration}
                      onVoiceInput={
                        (app?.inputMode?.microphone?.enabled ?? app?.microphone?.enabled) !== false
                          ? handleVoiceInput
                          : undefined
                      }
                      onVoiceCommand={
                        (app?.inputMode?.microphone?.enabled ?? app?.microphone?.enabled) !== false
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
                </div>
              </div>
              
              {/* Desktop layout: everything centered together */}
              <div className="hidden md:flex md:flex-col md:h-full md:items-center md:justify-center">
                <div className="w-full max-w-4xl">
                  {messages.length > 0 ? (
                    <div className="mb-8">
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
                      />
                    </div>
                  ) : (
                    <div className="mb-8">
                      {renderStartupState(app, welcomeMessage, handleStarterPromptClick)}
                    </div>
                  )}
                  <div>
                    <ChatInput
                      app={app}
                      value={input}
                      onChange={handleInputChange}
                      onSubmit={handleSubmit}
                      isProcessing={processing}
                      onCancel={cancelGeneration}
                      onVoiceInput={
                        (app?.inputMode?.microphone?.enabled ?? app?.microphone?.enabled) !== false
                          ? handleVoiceInput
                          : undefined
                      }
                      onVoiceCommand={
                        (app?.inputMode?.microphone?.enabled ?? app?.microphone?.enabled) !== false
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
                </div>
              </div>
            </>
          ) : (
            /* Standard layout for normal chat and starter prompts */
            <>
              {/* Mobile layout: content scrollable, input at bottom */}
              <div className="flex flex-col h-full md:hidden">
                <div className="flex-1 overflow-hidden">
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
                    welcomeMessage={welcomeMessage}
                    showCenteredInput={shouldCenterInput}
                  />
                </div>
                <div className="flex-shrink-0 px-4 pt-2">
                  <ChatInput
                    app={app}
                    value={input}
                    onChange={handleInputChange}
                    onSubmit={handleSubmit}
                    isProcessing={processing}
                    onCancel={cancelGeneration}
                    onVoiceInput={
                      (app?.inputMode?.microphone?.enabled ?? app?.microphone?.enabled) !== false
                        ? handleVoiceInput
                        : undefined
                    }
                    onVoiceCommand={
                      (app?.inputMode?.microphone?.enabled ?? app?.microphone?.enabled) !== false
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
              </div>
              
              {/* Desktop layout: normal flex column */}
              <div className="hidden md:flex md:flex-col md:h-full">
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
                  welcomeMessage={welcomeMessage}
                  showCenteredInput={shouldCenterInput}
                />

                <ChatInput
                  app={app}
                  value={input}
                  onChange={handleInputChange}
                  onSubmit={handleSubmit}
                  isProcessing={processing}
                  onCancel={cancelGeneration}
                  onVoiceInput={
                    (app?.inputMode?.microphone?.enabled ?? app?.microphone?.enabled) !== false
                      ? handleVoiceInput
                      : undefined
                  }
                  onVoiceCommand={
                    (app?.inputMode?.microphone?.enabled ?? app?.microphone?.enabled) !== false
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
            </>
          )}
        </div>

        {app?.variables && app.variables.length > 0 && (
          <div className="hidden md:block w-80 lg:w-96 overflow-y-auto p-4 bg-gray-50 rounded-lg flex-shrink-0">
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
