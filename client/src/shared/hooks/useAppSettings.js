import { useState, useEffect } from 'react';
import { saveAppSettings, loadAppSettings } from '../../utils/appSettings';
import { fetchModels, fetchStyles } from '../../api/api';
import { useUIConfig } from '../contexts/UIConfigContext';

/**
 * Custom hook for managing app settings across chat and canvas modes
 * Provides shared state management for model, style, temperature, etc.
 */
const useAppSettings = (appId, app) => {
  const { setHeaderColor } = useUIConfig();

  // Configuration states
  const [selectedModel, setSelectedModel] = useState(null);
  const [selectedStyle, setSelectedStyle] = useState('normal');
  const [selectedOutputFormat, setSelectedOutputFormat] = useState('markdown');
  const [temperature, setTemperature] = useState(0.7);
  const [sendChatHistory, setSendChatHistory] = useState(true);
  const [thinkingEnabled, setThinkingEnabled] = useState(null);
  const [thinkingBudget, setThinkingBudget] = useState(null);
  const [thinkingThoughts, setThinkingThoughts] = useState(null);

  // Models and styles data
  const [models, setModels] = useState([]);
  const [styles, setStyles] = useState([]);

  // Loading states
  const [modelsLoading, setModelsLoading] = useState(true);
  const [stylesLoading, setStylesLoading] = useState(true);

  // Load models and styles
  useEffect(() => {
    const loadModelsAndStyles = async () => {
      try {
        setModelsLoading(true);
        setStylesLoading(true);

        const [modelsData, stylesData] = await Promise.all([fetchModels(), fetchStyles()]);

        setModels(modelsData || []);
        setStyles(stylesData || []);
      } catch (error) {
        console.error('Failed to load models and styles:', error);
      } finally {
        setModelsLoading(false);
        setStylesLoading(false);
      }
    };

    loadModelsAndStyles();
  }, []);

  // Initialize settings from app data when app loads
  useEffect(() => {
    if (!app || modelsLoading) return;

    // Set header color
    if (app.color) {
      setHeaderColor(app.color);
    }

    const defaultModel = models.find(m => m.default);

    let initialModel = app.preferredModel;
    if (!models.some(m => m.id === initialModel)) {
      initialModel = defaultModel ? defaultModel.id : models[0]?.id || null;
    }

    // Initialize with app defaults
    const initialState = {
      selectedModel: initialModel,
      selectedStyle: app.preferredStyle || 'normal',
      temperature: app.preferredTemperature || 0.7,
      selectedOutputFormat: app.preferredOutputFormat || 'markdown',
      sendChatHistory: true,
      thinkingEnabled: app.thinking?.enabled ?? null,
      thinkingBudget: app.thinking?.budget ?? null,
      thinkingThoughts: app.thinking?.thoughts ?? null
    };

    // Set initial states
    setSelectedModel(initialState.selectedModel);
    setSelectedStyle(initialState.selectedStyle);
    setTemperature(initialState.temperature);
    setSelectedOutputFormat(initialState.selectedOutputFormat);
    setSendChatHistory(initialState.sendChatHistory);
    setThinkingEnabled(initialState.thinkingEnabled);
    setThinkingBudget(initialState.thinkingBudget);
    setThinkingThoughts(initialState.thinkingThoughts);

    // Load saved settings and override defaults if available
    const savedSettings = loadAppSettings(appId);
    if (savedSettings) {
      if (savedSettings.selectedModel && models.some(m => m.id === savedSettings.selectedModel))
        setSelectedModel(savedSettings.selectedModel);
      if (savedSettings.selectedStyle) setSelectedStyle(savedSettings.selectedStyle);
      if (savedSettings.selectedOutputFormat)
        setSelectedOutputFormat(savedSettings.selectedOutputFormat);
      if (savedSettings.temperature) setTemperature(savedSettings.temperature);
      if (savedSettings.sendChatHistory !== undefined)
        setSendChatHistory(savedSettings.sendChatHistory);
      if (savedSettings.thinkingEnabled !== undefined)
        setThinkingEnabled(savedSettings.thinkingEnabled);
      if (savedSettings.thinkingBudget !== undefined)
        setThinkingBudget(savedSettings.thinkingBudget);
      if (savedSettings.thinkingThoughts !== undefined)
        setThinkingThoughts(savedSettings.thinkingThoughts);
    }
  }, [app, appId, setHeaderColor, models, modelsLoading]);

  // Save settings when they change
  useEffect(() => {
    if (app) {
      saveAppSettings(appId, {
        selectedModel,
        selectedStyle,
        selectedOutputFormat,
        temperature,
        sendChatHistory,
        thinkingEnabled,
        thinkingBudget,
        thinkingThoughts
      });
    }
  }, [
    appId,
    app,
    selectedModel,
    selectedStyle,
    selectedOutputFormat,
    temperature,
    sendChatHistory,
    thinkingEnabled,
    thinkingBudget,
    thinkingThoughts
  ]);

  // Settings object for easy passing to components
  const settings = {
    selectedModel,
    selectedStyle,
    selectedOutputFormat,
    temperature,
    sendChatHistory,
    thinkingEnabled,
    thinkingBudget,
    thinkingThoughts
  };

  // Setters object for easy passing to components
  const setters = {
    setSelectedModel,
    setSelectedStyle,
    setSelectedOutputFormat,
    setTemperature,
    setSendChatHistory,
    setThinkingEnabled,
    setThinkingBudget,
    setThinkingThoughts
  };

  return {
    // Settings state
    ...settings,

    // Setters
    ...setters,

    // Data
    models,
    styles,

    // Loading states
    modelsLoading,
    stylesLoading,

    // Convenience objects
    settings,
    setters
  };
};

export default useAppSettings;
