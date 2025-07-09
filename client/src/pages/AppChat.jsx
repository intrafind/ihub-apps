import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { v4 as uuidv4 } from "uuid";
import { getOrCreateChatId, resetChatId } from "../utils/chatId";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import {
  fetchAppDetails,
  isTimeoutError,
  generateMagicPrompt,
} from "../api/api";
import LoadingSpinner from "../components/LoadingSpinner";
import { useTranslation } from "react-i18next";
import { getLocalizedContent } from "../utils/localizeContent";
import Icon from "../components/Icon";
import AppShareModal from "../components/AppShareModal";

// Import our custom hooks and components
import useAppChat from "../hooks/useAppChat";
import useVoiceCommands from "../hooks/useVoiceCommands";
import useAppSettings from "../hooks/useAppSettings";
import ChatInput from "../components/chat/ChatInput";
import ChatMessageList from "../components/chat/ChatMessageList";
import StarterPromptsView from "../components/chat/StarterPromptsView";
import GreetingView from "../components/chat/GreetingView";
import NoMessagesView from "../components/chat/NoMessagesView";
import InputVariables from "../components/chat/InputVariables";
import SharedAppHeader from "../components/SharedAppHeader";
import { useUIConfig } from "../components/UIConfigContext";
import cache, { CACHE_KEYS } from "../utils/cache"; // Import cache for manual clearing
import { recordAppUsage } from "../utils/recentApps";
import { isMarkdown } from "../utils/markdownUtils";
import { saveAppSettings, loadAppSettings } from '../utils/appSettings';

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

const renderStartupState = (app, welcomeMessage, handleStarterPromptClick) => {
  const starterPrompts = app?.starterPrompts || [];
  if (starterPrompts.length > 0) {
    return (
      <StarterPromptsView starterPrompts={starterPrompts} onSelectPrompt={handleStarterPromptClick} />
    );
  } else if (welcomeMessage) {
    return <GreetingView welcomeMessage={welcomeMessage} />;
  }
  return <NoMessagesView />;
};


const AppChat = () => {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const { appId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const prefillMessage = searchParams.get('prefill') || "";
  const [app, setApp] = useState(null);
  const [input, setInput] = useState(prefillMessage);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showConfig, setShowConfig] = useState(false);
  const [variables, setVariables] = useState({});
  const [showParameters, setShowParameters] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const { uiConfig } = useUIConfig();

  // Shared app settings hook
  const {
    selectedModel,
    selectedStyle,
    selectedOutputFormat,
    temperature,
    sendChatHistory,
    models,
    styles,
    setSelectedModel,
    setSelectedStyle,
    setSelectedOutputFormat,
    setTemperature,
    setSendChatHistory,
  } = useAppSettings(appId, app);

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
  const chatId = useRef(getOrCreateChatId(appId));

  // Restore existing chat ID when the appId changes
  useEffect(() => {
    chatId.current = getOrCreateChatId(appId);
  }, [appId]);

  /**
   * Determine if the response should trigger auto-redirect to canvas mode
   * Simplified to check if canvas is enabled and response is substantial
   * @param {string} response - The AI response content
   * @param {string} userInput - The user's input that triggered the response
   * @returns {boolean} True if should redirect to canvas
   */
  const shouldAutoRedirectToCanvas = useCallback((response, userInput) => {
    console.log('🔍 shouldAutoRedirectToCanvas check:', {
      hasResponse: !!response,
      responseLength: response?.length || 0,
      hasUserInput: !!userInput,
      hasApp: !!app,
      canvasEnabled: app?.features?.canvas
    });
    
    if (!response || !userInput || !app) return false;
    const shouldRedirect = response.length > 200 && app?.features?.canvas === true;
    
    console.log('📋 Auto-redirect decision:', { shouldRedirect, responseLength: response.length, canvasEnabled: app?.features?.canvas });
    return shouldRedirect;
  }, [app]);

  // Handle opening content in canvas mode
  const handleOpenInCanvas = useCallback((content) => {
    if (!content || !app) return;
    
    const encodedContent = encodeURIComponent(content);
    navigate(`/apps/${appId}/canvas?content=${encodedContent}`);
  }, [navigate, appId, app]);

  // Handle auto-redirect to canvas when message is completed
  const handleMessageComplete = useCallback((aiResponse, userInput) => {
    console.log('🎯 handleMessageComplete called:', { 
      responseLength: aiResponse?.length || 0, 
      userInput, 
      canvasEnabled: app?.features?.canvas,
      shouldRedirect: shouldAutoRedirectToCanvas(aiResponse, userInput)
    });
    
    // Check if we should auto-redirect to canvas mode
    if (shouldAutoRedirectToCanvas(aiResponse, userInput)) {
      console.log('🎨 Auto-redirecting to canvas mode with response:', { responseLength: aiResponse?.length, userInput });
      handleOpenInCanvas(aiResponse);
    }
  }, [shouldAutoRedirectToCanvas, handleOpenInCanvas, app]);

  const {
    messages,
    processing,
    sendMessage: sendChatMessage,
    resendMessage: prepareResend,
    deleteMessage,
    editMessage,
    clearMessages,
    cancelGeneration,
    addSystemMessage,
  } = useAppChat({
    appId,
    chatId: chatId.current,
    onMessageComplete: handleMessageComplete
  });

  // Set up voice commands
  const { handleVoiceInput, handleVoiceCommand } = useVoiceCommands({
    messages,
    clearChat: () => {
      cancelGeneration();
      clearMessages();
      chatId.current = resetChatId(appId);
      
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

        if (isMounted) {
          setApp(appData);
        }

        // Process variables if available
        if (appData.variables && isMounted) {
          const initialVars = getInitializedVariables(appData, currentLanguage);
          if (isMounted) {
            setVariables(initialVars);
          }
        }

        if (isMounted) {
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
  }, [appId, currentLanguage, t]);

  // Load saved variables from sessionStorage when initializing
  useEffect(() => {
    if (app && !loading) {
      const savedSettings = loadAppSettings(appId);
      if (savedSettings && savedSettings.variables) {
        setVariables(savedSettings.variables);
        console.log(
          "Restored app variables from sessionStorage:",
          savedSettings.variables
        );
      }
    }
  }, [app, loading, appId]);

  // Save variables to sessionStorage whenever they change
  useEffect(() => {
    if (app && !loading) {
      const settings = {
        variables,
      };

      saveAppSettings(appId, settings);
    }
  }, [app, loading, appId, variables]);

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
    const resendData = prepareResend(messageId, editedContent);
    const { content: contentToResend, variables: variablesToRestore, imageData: imageDataToRestore, fileData: fileDataToRestore } = resendData;
    
    // Allow resending if there's content OR if the app allows empty content (for variable-only messages)
    if (!contentToResend && !imageDataToRestore && !fileDataToRestore && !app?.allowEmptyContent) return;

    setInput(contentToResend || '');
    
    // Restore variables if they exist
    if (variablesToRestore) {
      setVariables(variablesToRestore);
    }
    
    // Restore image data if it exists
    if (imageDataToRestore) {
      setSelectedImage(imageDataToRestore);
    }
    
    // Restore file data if it exists
    if (fileDataToRestore) {
      setSelectedFile(fileDataToRestore);
    }
    
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
      cancelGeneration();
      clearMessages();
      chatId.current = resetChatId(appId);
      
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


  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!input.trim() && !selectedImage && !selectedFile && !app?.allowEmptyContent) {
      return;
    }

    if (app?.variables) {
      const missingRequiredVars = app.variables
        .filter((v) => v.required)
        .filter((v) => !variables[v.name] || variables[v.name].trim() === "");
      if (missingRequiredVars.length > 0) {
        const errorMessage =
          t('error.missingRequiredFields', 'Please fill in all required fields:') +
          ' ' +
          missingRequiredVars.map((v) => getLocalizedContent(v.label, currentLanguage)).join(', ');
        addSystemMessage(errorMessage, true);
        if (window.innerWidth < 768 && !showParameters) {
          toggleParameters();
        }
        return;
      }
    }

    if (processing) return;

    let finalInput = input.trim();
    let messageContent = finalInput;
    let messageData = null;

    if (selectedImage) {
      const imgPreview = `<img src="${selectedImage.base64}" alt="Uploaded image" style="max-width: 100%; max-height: 300px; margin-top: 8px;" />`;
      messageContent = finalInput ? `${finalInput}\n\n${imgPreview}` : imgPreview;
      messageData = { imageData: selectedImage };
    }

    if (selectedFile) {
      const fileIndicator = `<div style="display: inline-flex; align-items: center; background-color: #4b5563; border: 1px solid #d1d5db; border-radius: 6px; padding: 4px 8px; margin-left: 8px; font-size: 0.875em; color: #ffffff;">\n        <span style="margin-right: 4px;">📎</span>\n        <span>${selectedFile.fileName}</span>\n      </div>`;
      messageContent = finalInput ? `${finalInput} ${fileIndicator}` : fileIndicator;
      messageData = { fileData: selectedFile };
    }

    sendChatMessage({
      displayMessage: {
        content: messageContent,
        meta: {
          rawContent: input,
          variables: app?.variables && app.variables.length > 0 ? { ...variables } : undefined,
          ...messageData,
        },
      },
      apiMessage: {
        content: input,
        promptTemplate: app?.prompt || null,
        variables: { ...variables },
        imageData: selectedImage,
        fileData: selectedFile,
      },
      params: {
        modelId: selectedModel,
        style: selectedStyle,
        temperature,
        outputFormat: selectedOutputFormat,
        language: currentLanguage,
        ...(useMaxTokens ? { useMaxTokens: true } : {}),
      },
      sendChatHistory,
    });

    setInput('');
    setOriginalInput(null);
    setSelectedImage(null);
    setShowImageUploader(false);
    setSelectedFile(null);
    setShowFileUploader(false);
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

  const toggleCanvas = () => {
    navigate(`/apps/${appId}/canvas`);
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

  return (
    <div className="flex flex-col h-[calc(100vh-10rem)] max-h-[calc(100vh-10rem)] min-h-0 overflow-hidden pt-4 pb-2">
      {/* Shared App Header */}
      <SharedAppHeader
        app={app}
        appId={appId}
        mode="chat"
        messages={messages}
        onClearChat={clearChat}
        currentLanguage={currentLanguage}
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
        showConfig={showConfig}
        onToggleConfig={toggleConfig}
        onToggleParameters={toggleParameters}
        showParameters={showParameters}
        onShare={() => setShowShare(true)}
        showShareButton={true}
      />

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
                <Icon 
                  name="close" 
                  size="lg" 
                  className="text-current" 
                />
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
                        onOpenInCanvas={handleOpenInCanvas}
                        canvasEnabled={app?.features?.canvas === true}
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
                      imageUploadConfig={app?.imageUpload || {}}
                      onFileSelect={handleFileSelect}
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
                        onOpenInCanvas={handleOpenInCanvas}
                        canvasEnabled={app?.features?.canvas === true}
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
                      imageUploadConfig={app?.imageUpload || {}}
                      onFileSelect={handleFileSelect}
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
                    onOpenInCanvas={handleOpenInCanvas}
                    canvasEnabled={app?.features?.canvas === true}
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
                    imageUploadConfig={app?.imageUpload || {}}
                    onFileSelect={handleFileSelect}
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
                  onOpenInCanvas={handleOpenInCanvas} 
                  canvasEnabled={app?.features?.canvas === true}
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
                  imageUploadConfig={app?.imageUpload || {}}
                  onFileSelect={handleFileSelect}
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
      {showShare && (
        <AppShareModal
          appId={appId}
          path={window.location.pathname}
          params={{
            model: selectedModel,
            style: selectedStyle,
            outfmt: selectedOutputFormat,
            temp: temperature,
            history: sendChatHistory,
            prefill: prefillMessage,
            ...Object.fromEntries(
              Object.entries(variables).map(([k, v]) => [`var_${k}`, v])
            ),
          }}
          onClose={() => setShowShare(false)}
        />
      )}
    </div>
  );
};

export default AppChat;
