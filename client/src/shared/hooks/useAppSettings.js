import { useState, useEffect, useRef } from 'react';
import { saveAppSettings, loadAppSettings } from '../../utils/appSettings';
import { fetchModels, fetchStyles } from '../../api';
import { filterModelsForApp, pickInitialModelForApp } from '../../utils/modelFiltering';
import { useUIConfig } from '../contexts/UIConfigContext';

/**
 * Custom hook for managing app settings across chat and canvas modes
 * Provides shared state management for model, style, temperature, etc.
 *
 * Three layers, applied in this order, each overriding the last:
 *
 * 1. the app's own defaults,
 * 2. what this browser last used for the app (`localStorage`),
 * 3. `chatSettings` — what the chat being opened was last answered with.
 *
 * The third layer only exists for a stored chat. Reopening one used to come
 * back with the app's defaults, so a chat the user had turned websearch on for
 * silently answered the next question without it. Applying it last, inside the
 * same effect as the other two, is what keeps it applied: the effect re-runs
 * whenever the app or the model list settles, and anything applied outside it
 * would be overwritten the next time it did.
 *
 * All three layers are applied **once per chat**, not on every re-run of the
 * effect. The chat's snapshot is frozen at the moment the chat was hydrated, so
 * a re-run re-applies a stale value on top of whatever the user has since
 * chosen: switch the interface language mid-chat and the app is refetched, the
 * effect re-runs on the new object, and the websearch toggle the user just
 * turned off comes back on because the chat document still says it was on. The
 * signature below is what stops that — a different app, leaving a chat that had
 * stored settings, and those settings arriving are what re-initialize, and
 * nothing else does.
 *
 * @param {string} appId - App id.
 * @param {Object} app - App configuration.
 * @param {Object} [options]
 * @param {Object|null} [options.chatSettings] - Settings stored on the chat being
 *   opened, or null for a new or non-persisted chat.
 */
function useAppSettings(appId, app, { chatSettings = null } = {}) {
  const { setHeaderColor } = useUIConfig();

  // Configuration states
  const [selectedModel, setSelectedModel] = useState(null);
  const [selectedStyle, setSelectedStyle] = useState('normal');
  const [selectedOutputFormat, setSelectedOutputFormat] = useState('markdown');
  const [temperature, setTemperature] = useState(0.7);
  const [sendChatHistory, setSendChatHistory] = useState(true);
  const [ephemeral, setEphemeral] = useState(false);
  const [thinkingEnabled, setThinkingEnabled] = useState(null);
  const [thinkingBudget, setThinkingBudget] = useState(null);
  const [thinkingThoughts, setThinkingThoughts] = useState(null);
  const [enabledTools, setEnabledTools] = useState([]);
  const [websearchEnabled, setWebsearchEnabled] = useState(false);
  // Per-message host-context toggles. The Outlook taskpane and the
  // browser extension declare which toggles to surface via
  // EmbeddedHostAdapter.contextToggles; this is the user-visible state
  // map. Empty object in the main web app — no toggles render there.
  const [hostContextFlags, setHostContextFlags] = useState({});
  const [imageAspectRatio, setImageAspectRatio] = useState('1:1');
  const [imageQuality, setImageQuality] = useState('Medium');

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

  // The app these settings belong to. `appId` is what was *asked* for, and
  // following a link to another app changes it a render before the fetch that
  // replaces `app` resolves — so for that gap the two disagree, and anything
  // keyed on `appId` alone reads and writes the next app's settings while the
  // values in hand are still the previous app's.
  const settingsAppId = app?.id ?? appId;

  // What the last initialization was for — see the signature note in the hook
  // doc. A ref rather than state: nothing renders from it, and it has to be
  // readable by the very effect run that sets it.
  const initializedForRef = useRef(null);

  // Initialize settings from app data when app loads
  useEffect(() => {
    if (!app || modelsLoading) return;

    // Set header color. Above the signature check on purpose: it is an
    // idempotent side effect on a context another page may have changed, not
    // part of resolving the user's settings.
    if (app.color) {
      setHeaderColor(app.color);
    }

    // Keyed by the loaded app, not the requested one: initializing during the
    // gap described above would resolve the next app's saved settings against
    // the previous app's config, and then mark the app initialized so the real
    // one never applied its own defaults when it arrived.
    const initFor = {
      appId: settingsAppId,
      // The snapshot's *presence*, not its identity. Opening a chat runs this
      // twice — once before its stored settings have arrived, once after — and
      // both runs have to initialize. Re-reading the same chat afterwards (the
      // incognito toggle re-hydrates it) hands back an equal snapshot under a
      // new identity, and re-applying that is exactly the regression above.
      hasChatSettings: Boolean(chatSettings)
    };
    const previous = initializedForRef.current;
    if (
      previous &&
      previous.appId === initFor.appId &&
      previous.hasChatSettings === initFor.hasChatSettings
    ) {
      return;
    }
    initializedForRef.current = initFor;

    // Pick the initial model from the set of models that are actually
    // compatible with the app (allowedModels, tools requirement, settings
    // filter). Without this filter the initial selection could land on a
    // model that's excluded by the app — and since the model selector
    // auto-hides when only one compatible model remains, the user would
    // never see the mismatch but the chat would behave as if the wrong
    // model was selected (e.g. image generation controls and vision
    // uploads disappear because the resolved model doesn't support them).
    const initialModel = pickInitialModelForApp(models, app);

    // Initialize with app defaults
    const initialState = {
      selectedModel: initialModel,
      selectedStyle: app.preferredStyle || 'normal',
      temperature: app.preferredTemperature || 0.7,
      selectedOutputFormat: app.preferredOutputFormat || 'markdown',
      sendChatHistory: true,
      ephemeral: app.ephemeral ?? false,
      thinkingEnabled: app.thinking?.enabled ?? null,
      thinkingBudget: app.thinking?.budget ?? null,
      thinkingThoughts: app.thinking?.thoughts ?? null,
      enabledTools: app.tools || [],
      websearchEnabled: app.websearch?.enabledByDefault ?? false,
      imageAspectRatio: app.imageGeneration?.aspectRatio || '1:1',
      imageQuality: app.imageGeneration?.quality || 'Medium'
    };

    // Set initial states
    setSelectedModel(initialState.selectedModel);
    setSelectedStyle(initialState.selectedStyle);
    setTemperature(initialState.temperature);
    setSelectedOutputFormat(initialState.selectedOutputFormat);
    setSendChatHistory(initialState.sendChatHistory);
    setEphemeral(initialState.ephemeral);
    setThinkingEnabled(initialState.thinkingEnabled);
    setThinkingBudget(initialState.thinkingBudget);
    setThinkingThoughts(initialState.thinkingThoughts);
    setEnabledTools(initialState.enabledTools);
    setWebsearchEnabled(initialState.websearchEnabled);
    setImageAspectRatio(initialState.imageAspectRatio);
    setImageQuality(initialState.imageQuality);

    // Load saved settings and override defaults if available
    const savedSettings = loadAppSettings(settingsAppId);
    if (savedSettings) {
      // Only restore the saved model if it's still compatible with the
      // current app config — otherwise we'd resurrect a stale selection
      // (e.g. after the admin tightened allowedModels) and bypass the
      // initial-model logic above.
      const compatibleModels = filterModelsForApp(models, app);
      if (
        savedSettings.selectedModel &&
        compatibleModels.some(m => m.id === savedSettings.selectedModel)
      )
        setSelectedModel(savedSettings.selectedModel);
      if (savedSettings.selectedStyle) setSelectedStyle(savedSettings.selectedStyle);
      if (savedSettings.selectedOutputFormat)
        setSelectedOutputFormat(savedSettings.selectedOutputFormat);
      if (savedSettings.temperature) setTemperature(savedSettings.temperature);
      if (savedSettings.sendChatHistory !== undefined)
        setSendChatHistory(savedSettings.sendChatHistory);
      if (savedSettings.ephemeral !== undefined) setEphemeral(savedSettings.ephemeral);
      if (savedSettings.thinkingEnabled !== undefined)
        setThinkingEnabled(savedSettings.thinkingEnabled);
      if (savedSettings.thinkingBudget !== undefined)
        setThinkingBudget(savedSettings.thinkingBudget);
      if (savedSettings.thinkingThoughts !== undefined)
        setThinkingThoughts(savedSettings.thinkingThoughts);
      if (savedSettings.enabledTools !== undefined) setEnabledTools(savedSettings.enabledTools);
      if (savedSettings.websearchEnabled !== undefined)
        setWebsearchEnabled(savedSettings.websearchEnabled);
      if (savedSettings.hostContextFlags && typeof savedSettings.hostContextFlags === 'object')
        setHostContextFlags(savedSettings.hostContextFlags);
      if (savedSettings.imageAspectRatio !== undefined)
        setImageAspectRatio(savedSettings.imageAspectRatio);
      if (savedSettings.imageQuality !== undefined) setImageQuality(savedSettings.imageQuality);
    }

    // The chat's own settings are the last word. Only the keys it actually
    // recorded: a chat that never mentioned a style keeps the app's.
    if (chatSettings && typeof chatSettings === 'object') {
      if (chatSettings.style) setSelectedStyle(chatSettings.style);
      if (chatSettings.outputFormat) setSelectedOutputFormat(chatSettings.outputFormat);
      if (typeof chatSettings.temperature === 'number') setTemperature(chatSettings.temperature);
      if (typeof chatSettings.sendChatHistory === 'boolean')
        setSendChatHistory(chatSettings.sendChatHistory);
      if (typeof chatSettings.thinkingEnabled === 'boolean')
        setThinkingEnabled(chatSettings.thinkingEnabled);
      if (typeof chatSettings.thinkingBudget === 'number')
        setThinkingBudget(chatSettings.thinkingBudget);
      if (typeof chatSettings.thinkingThoughts === 'boolean')
        setThinkingThoughts(chatSettings.thinkingThoughts);
      if (Array.isArray(chatSettings.enabledTools)) setEnabledTools(chatSettings.enabledTools);
      if (typeof chatSettings.websearchEnabled === 'boolean')
        setWebsearchEnabled(chatSettings.websearchEnabled);
      if (chatSettings.imageAspectRatio) setImageAspectRatio(chatSettings.imageAspectRatio);
      if (chatSettings.imageQuality) setImageQuality(chatSettings.imageQuality);
      // The model the chat last used, but only if the app still allows it —
      // the same guard the browser-saved selection gets above.
      if (chatSettings.modelId) {
        const stillAllowed = filterModelsForApp(models, app);
        if (stillAllowed.some(m => m.id === chatSettings.modelId))
          setSelectedModel(chatSettings.modelId);
      }
    }
  }, [app, settingsAppId, chatSettings, setHeaderColor, models, modelsLoading]);

  // Save settings when they change
  useEffect(() => {
    if (app) {
      saveAppSettings(settingsAppId, {
        selectedModel,
        selectedStyle,
        selectedOutputFormat,
        temperature,
        sendChatHistory,
        ephemeral,
        thinkingEnabled,
        thinkingBudget,
        thinkingThoughts,
        enabledTools,
        websearchEnabled,
        hostContextFlags,
        imageAspectRatio,
        imageQuality
      });
    }
  }, [
    settingsAppId,
    app,
    selectedModel,
    selectedStyle,
    selectedOutputFormat,
    temperature,
    sendChatHistory,
    ephemeral,
    thinkingEnabled,
    thinkingBudget,
    thinkingThoughts,
    enabledTools,
    websearchEnabled,
    hostContextFlags,
    imageAspectRatio,
    imageQuality
  ]);

  // Settings object for easy passing to components
  const settings = {
    selectedModel,
    selectedStyle,
    selectedOutputFormat,
    temperature,
    sendChatHistory,
    ephemeral,
    thinkingEnabled,
    thinkingBudget,
    thinkingThoughts,
    enabledTools,
    websearchEnabled,
    hostContextFlags,
    imageAspectRatio,
    imageQuality
  };

  // Setters object for easy passing to components
  const setters = {
    setSelectedModel,
    setSelectedStyle,
    setSelectedOutputFormat,
    setTemperature,
    setSendChatHistory,
    setEphemeral,
    setThinkingEnabled,
    setThinkingBudget,
    setThinkingThoughts,
    setEnabledTools,
    setWebsearchEnabled,
    setHostContextFlags,
    setImageAspectRatio,
    setImageQuality
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
}

export default useAppSettings;
