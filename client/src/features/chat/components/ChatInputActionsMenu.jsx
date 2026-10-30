// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { fetchToolsBasic } from '../../../api';
import { VoiceInputComponent } from '../../voice/components';
import MagicPromptLoader from '../../../shared/components/MagicPromptLoader';
import ImageGenerationControls from './ImageGenerationControls';
import { trackToolUsage } from '../../../utils/toolUsageTracker';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { groupToolsByMcpServer } from '../utils/groupToolsByMcpServer';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import { useEmbeddedHost } from '../../office/contexts/EmbeddedHostContext';
import { useKeyboardNavigation } from '../../../shared/hooks/useKeyboardNavigation';
import { boundIntegrationRefs } from '../../../shared/utils/boundIntegrationRefs';
import {
  currentScopeOf,
  scopeActionLabel,
  scopeDisplayName,
  scopeHint
} from '../utils/integrationScopes';

/**
 * ChatInputActionsMenu component - unified menu for all chat input actions
 * Consolidates tools, file upload, magic prompt, and voice input into one menu
 * Supports single action optimization and tool usage tracking
 */
function ChatInputActionsMenu({
  app,
  enabledTools,
  onEnabledToolsChange,
  // Upload props
  uploadConfig,
  onToggleUploader,
  disabled,
  isProcessing,
  // Magic prompt props
  magicPromptEnabled,
  onMagicPrompt,
  showUndoMagicPrompt,
  onUndoMagicPrompt,
  magicPromptLoading,
  // Voice props
  onVoiceInput,
  onVoiceCommand,
  inputRef,
  // Image generation props
  model,
  imageAspectRatio,
  imageQuality,
  onImageAspectRatioChange,
  onImageQualityChange,
  // Cloud storage props
  onCloudProviderSelect,
  // Websearch props
  websearchEnabled = false,
  onWebsearchEnabledChange = null,
  // Host-context toggles (Outlook taskpane / browser-extension side panel).
  // The host adapter declares which toggles to render via
  // EmbeddedHostAdapter.contextToggles (read below via useEmbeddedHost).
  // `hostContextFlags` is the user-visible state map keyed by toggle.key.
  hostContextFlags = null,
  onHostContextFlagChange = null,
  // Integration scopes (#3050): where an integration searches, whom it asks.
  // `integrationScopes` is `useIntegrationScopes().integrations`; each row
  // shows the scope in use and opens a submenu to change it.
  integrationScopes = null,
  onIntegrationScopeChange = null
}) {
  const { t, i18n } = useTranslation();
  const { platformConfig } = usePlatformConfig();
  // Embedded-host adapter (Outlook taskpane / browser-extension side panel)
  // declares which "Include …" toggles to render under the `+` menu via
  // its `contextToggles` array. Empty in the main web app — the section
  // below renders nothing. The Outlook taskpane intentionally declares no
  // toggles (issue #1467) because the OfficeMailContextBanner already
  // surfaces equivalent controls; the browser extension still uses this
  // mechanism for its `Include page` toggle.
  const embeddedHost = useEmbeddedHost();
  const hostContextToggles =
    onHostContextFlagChange && Array.isArray(embeddedHost?.contextToggles)
      ? embeddedHost.contextToggles
      : [];
  const [isOpen, setIsOpen] = useState(false);
  const [availableTools, setAvailableTools] = useState([]);
  const [toolsLoading, setToolsLoading] = useState(false);
  // The integration whose scope submenu is open, if any.
  const [openScopeMenu, setOpenScopeMenu] = useState(null);
  const dropdownRef = useRef(null);
  const actionsMenuRef = useRef(null);
  const triggerRef = useRef(null);

  /** Closes the actions menu dropdown */
  const handleActionsMenuClose = useCallback(() => setIsOpen(false), []);

  const { activeIndex: menuActiveIndex } = useKeyboardNavigation(actionsMenuRef, {
    isActive: isOpen,
    onClose: handleActionsMenuClose
  });

  // Get enabled cloud storage providers
  const cloudStorage = platformConfig?.cloudStorage || { enabled: false, providers: [] };
  const cloudStorageConfig = uploadConfig?.cloudStorageUpload || {};
  const isCloudStorageEnabledForApp = cloudStorageConfig.enabled === true;
  const enabledCloudProviders =
    cloudStorage.enabled && isCloudStorageEnabledForApp
      ? cloudStorage.providers.filter(p => p.enabled)
      : [];

  // Load tool metadata when component mounts. Workflows live in app.workflows now
  // and are triggered via @mentions, so they are intentionally not surfaced here.
  useEffect(() => {
    const loadTools = async () => {
      if ((!app?.tools || app.tools.length === 0) && boundIntegrationRefs(app).length === 0) return;

      try {
        setToolsLoading(true);
        const tools = await fetchToolsBasic({ appId: app.id });
        setAvailableTools(tools || []);
      } catch (error) {
        console.error('Failed to fetch tools:', error);
        setAvailableTools([]);
      } finally {
        setToolsLoading(false);
      }
    };

    void loadTools();
  }, [app?.id, app?.tools, app?.integrations]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = event => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Interactive clarification tools (`ask_user`, anything `requiresUserInput`)
  // are a system channel the agent loop drives, not a user-selectable
  // capability: the model always has them when the app grants them (the server
  // keeps them whatever `enabledTools` says — see getToolsForApp). They never
  // appear in this menu, because a toggle here could only strip the model's
  // ability to ask the user a question, which is exactly the failure it was
  // mistaken for.
  const isInteractiveToolRef = toolId =>
    toolId === 'ask_user' ||
    availableTools.find(tool => tool.id === toolId)?.requiresUserInput === true;
  // Installed integrations the app binds are tools too, one toggle per
  // installation (its actions fold into it like an MCP server's tools).
  const selectableToolRefs = [...(app?.tools || []), ...boundIntegrationRefs(app)].filter(
    id => !isInteractiveToolRef(id)
  );

  const { grouped, individual } = groupToolsByMcpServer(selectableToolRefs, availableTools, name =>
    getLocalizedContent(name, i18n.language)
  );

  const toggleTool = (toolId, isGroup = false, groupTools = []) => {
    if (isGroup) {
      const allEnabled = groupTools.every(t => enabledTools.includes(t));
      let newEnabledTools;

      if (allEnabled) {
        newEnabledTools = enabledTools.filter(t => !groupTools.includes(t));
        // Track usage for each tool in the group
        groupTools.forEach(tool => trackToolUsage(app.id, tool, false));
      } else {
        const toAdd = groupTools.filter(t => !enabledTools.includes(t));
        newEnabledTools = [...enabledTools, ...toAdd];
        // Track usage for each newly enabled tool
        toAdd.forEach(tool => trackToolUsage(app.id, tool, true));
      }

      onEnabledToolsChange?.(newEnabledTools);
    } else {
      const isEnabled = enabledTools.includes(toolId);
      const newEnabledTools = isEnabled
        ? enabledTools.filter(t => t !== toolId)
        : [...enabledTools, toolId];

      // Track this tool usage
      trackToolUsage(app.id, toolId, !isEnabled);

      onEnabledToolsChange?.(newEnabledTools);
    }
  };

  const hasTools = selectableToolRefs.length > 0 && enabledTools !== null;
  // The references the menu shows: one toggle per MCP server plus plain tools.
  const menuToolRefs = [...grouped.flatMap(g => g.matchedTools), ...individual];
  const toolCount = menuToolRefs.length;
  const enabledCount = hasTools ? menuToolRefs.filter(ref => enabledTools.includes(ref)).length : 0;
  const hasWebsearch = app?.websearch?.enabled === true && onWebsearchEnabledChange !== null;
  const scopeIntegrations = (Array.isArray(integrationScopes) ? integrationScopes : []).filter(
    integration => integration.scopePicker !== 'hidden' && integration.scopes?.length > 0
  );
  const hasScopes = scopeIntegrations.length > 0 && onIntegrationScopeChange !== null;

  // Local upload covers the paper-clip / drop-zone affordance. Cloud storage
  // providers are rendered separately so they must remain available even when
  // local upload is disabled (issue #1426).
  const localUploadEnabled = uploadConfig?.localUploadEnabled === true;
  const hasCloudProviders = enabledCloudProviders.length > 0;

  // Count quick actions (non-tools actions)
  const quickActionCount =
    (localUploadEnabled ? 1 : 0) +
    (magicPromptEnabled && !showUndoMagicPrompt ? 1 : 0) +
    (showUndoMagicPrompt ? 1 : 0) +
    (onVoiceInput ? 1 : 0);

  // Check if we have any actions to show
  const hasHostContextToggles = hostContextToggles.length > 0;
  const hasActions =
    hasTools ||
    hasWebsearch ||
    hasScopes ||
    hasHostContextToggles ||
    hasCloudProviders ||
    quickActionCount > 0;

  if (!hasActions) return null;

  // Single action optimization: if we have exactly one action and no tools,
  // render that action directly without a menu
  const totalActions =
    quickActionCount +
    (hasTools ? 1 : 0) +
    (hasWebsearch ? 1 : 0) +
    (hasScopes ? 1 : 0) +
    (hasHostContextToggles ? 1 : 0);

  if (totalActions === 1 && quickActionCount === 1 && !hasTools && !hasCloudProviders) {
    // Render the single action directly
    if (localUploadEnabled) {
      return (
        <button
          type="button"
          onClick={onToggleUploader}
          disabled={disabled || isProcessing}
          title={t('chatActions.attachFile', 'Attach File')}
          className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
        >
          <Icon name="paper-clip" size="md" />
        </button>
      );
    }

    if (magicPromptEnabled && !showUndoMagicPrompt) {
      return (
        <button
          type="button"
          onClick={onMagicPrompt}
          disabled={disabled || isProcessing}
          title={t('common.magicPrompt', 'Magic Prompt')}
          className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
        >
          {magicPromptLoading ? <MagicPromptLoader /> : <Icon name="sparkles" size="md" />}
        </button>
      );
    }

    if (showUndoMagicPrompt) {
      return (
        <button
          type="button"
          onClick={onUndoMagicPrompt}
          disabled={disabled || isProcessing}
          title={t('common.undo', 'Undo')}
          className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
        >
          <Icon name="arrowLeft" size="md" />
        </button>
      );
    }

    if (onVoiceInput) {
      return (
        <div className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
          <VoiceInputComponent
            app={app}
            onSpeechResult={onVoiceInput}
            inputRef={inputRef}
            disabled={disabled || isProcessing}
            onCommand={onVoiceCommand}
          />
        </div>
      );
    }
  }

  // Compute the ordered list of navigable menu items matching the DOM order that
  // getNavigableElements discovers, so React-controlled tabIndex agrees with the
  // hook's activeIndex (prevents roving tabindex from being overwritten on re-render).
  const menuNavItems = [];
  if (localUploadEnabled && !(disabled || isProcessing)) menuNavItems.push('upload');
  if (magicPromptEnabled && !showUndoMagicPrompt && !(disabled || isProcessing))
    menuNavItems.push('magic');
  if (showUndoMagicPrompt && !(disabled || isProcessing)) menuNavItems.push('undo');
  enabledCloudProviders.forEach(p => {
    if (!(disabled || isProcessing)) menuNavItems.push(`cloud-${p.id}`);
  });
  if (hasWebsearch) menuNavItems.push('websearch');
  if (hasScopes) {
    scopeIntegrations.forEach(integration => {
      menuNavItems.push(`scope-${integration.id}`);
      if (openScopeMenu === integration.id) {
        integration.scopes.forEach(scope =>
          menuNavItems.push(`scope-${integration.id}-${scope.id}`)
        );
      }
    });
  }
  grouped.forEach(g => menuNavItems.push(`group-${g.id}`));
  individual.forEach(id => menuNavItems.push(`tool-${id}`));
  const navTabIndex = key => (menuNavItems.indexOf(key) === menuActiveIndex ? 0 : -1);

  // On desktop (md:), check if menu would be empty
  // Quick Actions and Image Generation are hidden on desktop with md:hidden
  // So only Cloud Storage, Web Search, and Tools remain visible on desktop
  const hasDesktopMenuContent =
    enabledCloudProviders.length > 0 ||
    hasWebsearch ||
    hasScopes ||
    hasTools ||
    hasHostContextToggles;

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Show + button on mobile always, on desktop only if menu has content */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={`p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors ${
          isOpen ? 'bg-gray-100 dark:bg-gray-700' : ''
        } md:${hasDesktopMenuContent ? 'block' : 'hidden'}`}
        title={t('chatActions.menu', 'Actions menu')}
        aria-label={t('chatActions.menu', 'Actions menu')}
      >
        <Icon name="plus-circle" size="md" />
        {hasTools && enabledCount < toolCount && (
          <span className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full border border-white dark:border-gray-800"></span>
        )}
      </button>

      {isOpen && (
        <div
          ref={actionsMenuRef}
          role="menu"
          aria-label={t('chatActions.menu', 'Actions menu')}
          className="absolute bottom-full left-0 mb-2 w-80 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 max-h-96 overflow-y-auto"
        >
          {/* Quick Actions Section - Hidden on desktop (md:) since actions are shown inline */}
          <div className="md:hidden p-3 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
              {t('chatActions.quickActions', 'Quick Actions')}
            </h3>
            <div className="flex flex-wrap gap-2">
              {localUploadEnabled && (
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={navTabIndex('upload')}
                  onClick={() => {
                    onToggleUploader?.();
                    setIsOpen(false);
                  }}
                  disabled={disabled || isProcessing}
                  title={t('chatActions.attachFile', 'Attach File')}
                  className="w-10 h-10 flex items-center justify-center bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 focus:bg-gray-200 dark:focus:bg-gray-600 focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800 rounded-lg disabled:opacity-50 transition-colors"
                >
                  <Icon name="paper-clip" size="sm" />
                </button>
              )}

              {magicPromptEnabled && !showUndoMagicPrompt && (
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={navTabIndex('magic')}
                  onClick={() => {
                    onMagicPrompt?.();
                    setIsOpen(false);
                  }}
                  disabled={disabled || isProcessing}
                  title={t('common.magicPrompt', 'Magic Prompt')}
                  className="w-10 h-10 flex items-center justify-center bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 focus:bg-gray-200 dark:focus:bg-gray-600 focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800 rounded-lg disabled:opacity-50 transition-colors"
                >
                  {magicPromptLoading ? <MagicPromptLoader /> : <Icon name="sparkles" size="sm" />}
                </button>
              )}

              {showUndoMagicPrompt && (
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={navTabIndex('undo')}
                  onClick={() => {
                    onUndoMagicPrompt?.();
                    setIsOpen(false);
                  }}
                  disabled={disabled || isProcessing}
                  className="flex items-center gap-2 px-3 py-2 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 focus:bg-gray-200 dark:focus:bg-gray-600 focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800 rounded-lg text-sm disabled:opacity-50 transition-colors"
                >
                  <Icon name="arrowLeft" size="sm" />
                  <span>{t('common.undo', 'Undo')}</span>
                </button>
              )}

              {onVoiceInput && (
                <div className="w-10 h-10 flex items-center justify-center bg-gray-100 dark:bg-gray-700 rounded-lg">
                  <VoiceInputComponent
                    app={app}
                    onSpeechResult={onVoiceInput}
                    inputRef={inputRef}
                    disabled={disabled || isProcessing}
                    onCommand={onVoiceCommand}
                  />
                </div>
              )}
            </div>
          </div>

          {/* Image Generation Settings - Show on mobile only if model supports it */}
          {model?.supportsImageGeneration && (
            <div className="p-3 border-b border-gray-200 dark:border-gray-700 md:hidden">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
                {t('appConfig.imageGeneration', 'Image Generation Settings')}
              </h3>
              <ImageGenerationControls
                app={app}
                model={model}
                imageAspectRatio={imageAspectRatio}
                imageQuality={imageQuality}
                onImageAspectRatioChange={onImageAspectRatioChange}
                onImageQualityChange={onImageQualityChange}
              />
            </div>
          )}

          {/* Cloud Storage Providers Section */}
          {enabledCloudProviders.length > 0 && (
            <div className="p-3 border-b border-gray-200 dark:border-gray-700">
              <div className="space-y-2">
                {enabledCloudProviders.map(provider => (
                  <button
                    key={provider.id}
                    type="button"
                    role="menuitem"
                    tabIndex={navTabIndex(`cloud-${provider.id}`)}
                    onClick={() => {
                      onCloudProviderSelect?.(provider);
                      setIsOpen(false);
                    }}
                    disabled={disabled || isProcessing}
                    className="w-full flex items-center p-3 hover:bg-gray-50 dark:hover:bg-gray-700 focus:bg-gray-50 dark:focus:bg-gray-700 focus:ring-2 focus:ring-indigo-500 focus:ring-inset rounded-lg disabled:opacity-50 transition-colors text-left"
                  >
                    <div className="shrink-0 w-10 h-10 flex items-center justify-center bg-blue-100 dark:bg-blue-900 rounded-lg">
                      <Icon name="cloud" size="md" className="text-blue-600 dark:text-blue-300" />
                    </div>
                    <div className="ml-3 flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        {provider.displayName || provider.name}
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                        {provider.type === 'office365'
                          ? t('admin.cloudStorage.office365', 'Microsoft Office 365')
                          : provider.type === 'googledrive'
                            ? t('admin.cloudStorage.googledrive', 'Google Drive')
                            : provider.type === 'nextcloud'
                              ? t('admin.cloudStorage.nextcloud', 'Nextcloud')
                              : provider.type}
                      </div>
                    </div>
                    <Icon
                      name="chevronRight"
                      size="sm"
                      className="text-gray-500 dark:text-gray-400 ml-2"
                    />
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Host context section — Outlook taskpane / browser extension */}
          {hostContextToggles.length > 0 && (
            <div
              className={`p-3 ${
                hasTools || hasWebsearch ? 'border-b border-gray-200 dark:border-gray-700' : ''
              }`}
            >
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
                {t('chat.input.contextSection', 'Message context')}
              </h3>
              <div className="space-y-1">
                {hostContextToggles.map(toggle => {
                  const enabled = hostContextFlags?.[toggle.key] ?? toggle.defaultEnabled ?? true;
                  return (
                    <div
                      key={toggle.key}
                      className="flex items-center justify-between p-2 hover:bg-gray-50 dark:hover:bg-gray-700 rounded-lg"
                    >
                      <div className="flex-1 min-w-0 mr-3">
                        <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                          {toggle.label}
                        </div>
                        {toggle.description && (
                          <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                            {toggle.description}
                          </div>
                        )}
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          checked={enabled}
                          onChange={e => onHostContextFlagChange?.(toggle.key, e.target.checked)}
                          className="sr-only peer"
                        />
                        <div className="w-11 h-6 bg-gray-200 peer-focus:outline-hidden peer-focus:ring-4 peer-focus:ring-indigo-300 dark:peer-focus:ring-indigo-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:rtl:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:inset-s-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-indigo-600"></div>
                      </label>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Web Search Section */}
          {hasWebsearch && (
            <div
              className={`p-3 ${
                hasTools || hasScopes ? 'border-b border-gray-200 dark:border-gray-700' : ''
              }`}
            >
              <div
                role="menuitemcheckbox"
                aria-checked={websearchEnabled}
                tabIndex={navTabIndex('websearch')}
                className="flex items-center justify-between p-2 hover:bg-gray-50 dark:hover:bg-gray-700 focus:bg-gray-50 dark:focus:bg-gray-700 focus:ring-2 focus:ring-indigo-500 focus:ring-inset rounded-lg cursor-pointer"
                onClick={() => onWebsearchEnabledChange?.(!websearchEnabled)}
                onKeyDown={e => {
                  if (e.key === ' ' || e.key === 'Enter') {
                    e.preventDefault();
                    onWebsearchEnabledChange?.(!websearchEnabled);
                  }
                }}
              >
                <div className="flex-1 min-w-0 mr-3">
                  <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {t('websearch.toggleLabel', 'Web Search')}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {t('websearch.toggleDescription', 'Search the web for up-to-date information')}
                  </div>
                </div>
                {/* Purely visual switch: the row owns the role, the state and
                    the interaction, so the checkbox only drives the `peer-*`
                    styling and is kept out of the tab order, out of the
                    accessibility tree and out of the click target. */}
                <span className="relative inline-flex items-center pointer-events-none">
                  <input
                    type="checkbox"
                    checked={websearchEnabled}
                    readOnly
                    tabIndex={-1}
                    aria-hidden="true"
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-gray-200 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:rtl:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:inset-s-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-indigo-600"></div>
                </span>
              </div>
            </div>
          )}

          {/* Integration scopes: where an integration searches, whom it asks */}
          {hasScopes && (
            <div
              className={`p-3 ${hasTools ? 'border-b border-gray-200 dark:border-gray-700' : ''}`}
            >
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
                {t('integrationScopes.menuTitle', 'Use in this chat')}
              </h3>
              <div className="space-y-1">
                {scopeIntegrations.map(integration => {
                  const integrationName = scopeDisplayName(integration, i18n.language);
                  const action = scopeActionLabel(integration, t);
                  const current = scopeDisplayName(currentScopeOf(integration), i18n.language);
                  // Not while a turn runs: it was sent with the scope shown.
                  const canPick =
                    !integration.fixed &&
                    integration.scopes.length > 1 &&
                    !(disabled || isProcessing);
                  const expanded = canPick && openScopeMenu === integration.id;
                  const hint = scopeHint(integration, t);
                  const toggle = () => {
                    if (canPick) setOpenScopeMenu(expanded ? null : integration.id);
                  };
                  return (
                    <div key={integration.id} role="none">
                      <div
                        role="menuitem"
                        aria-haspopup={canPick ? 'menu' : undefined}
                        aria-expanded={canPick ? expanded : undefined}
                        aria-disabled={canPick ? undefined : 'true'}
                        tabIndex={navTabIndex(`scope-${integration.id}`)}
                        className={`flex items-center justify-between gap-2 p-2 rounded-lg focus:bg-gray-50 dark:focus:bg-gray-700 focus:ring-2 focus:ring-indigo-500 focus:ring-inset ${
                          canPick ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700' : ''
                        }`}
                        onClick={toggle}
                        onKeyDown={e => {
                          if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') {
                            e.preventDefault();
                            if (!expanded || e.key !== 'ArrowRight') toggle();
                          } else if (e.key === 'ArrowLeft' && expanded) {
                            e.preventDefault();
                            setOpenScopeMenu(null);
                          }
                        }}
                        title={hint || undefined}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                            {integrationName}
                          </div>
                          <div className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400">
                            {action}: <span className="font-medium">{current}</span>
                            {integration.fixed && (
                              <span className="ml-1">
                                ({t('integrationScopes.fixed', 'Set by the app')})
                              </span>
                            )}
                          </div>
                        </div>
                        <Icon
                          name={
                            integration.fixed
                              ? 'lock-closed'
                              : expanded
                                ? 'chevronDown'
                                : 'chevronRight'
                          }
                          size="sm"
                          className="shrink-0 text-gray-500 dark:text-gray-400"
                          aria-hidden="true"
                        />
                      </div>
                      {expanded && (
                        <div
                          role="group"
                          aria-label={`${integrationName}: ${action}`}
                          className="ml-3 mt-1 space-y-0.5 border-l border-gray-200 pl-2 dark:border-gray-700"
                        >
                          {integration.scopes.map(scope => {
                            const isSelected = scope.id === integration.current;
                            // A pick is the whole job: close the menu, not
                            // just the submenu, and give focus back to "+".
                            const select = () => {
                              onIntegrationScopeChange(integration.id, scope.id);
                              setOpenScopeMenu(null);
                              setIsOpen(false);
                              triggerRef.current?.focus();
                            };
                            return (
                              <div
                                key={scope.id}
                                role="menuitemradio"
                                aria-checked={isSelected}
                                tabIndex={navTabIndex(`scope-${integration.id}-${scope.id}`)}
                                className={`flex cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm focus:ring-2 focus:ring-indigo-500 focus:ring-inset ${
                                  isSelected
                                    ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300'
                                    : 'text-gray-800 hover:bg-gray-50 focus:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-700 dark:focus:bg-gray-700'
                                }`}
                                onClick={select}
                                onKeyDown={e => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    select();
                                  }
                                }}
                              >
                                <span className="min-w-0 truncate">
                                  {scopeDisplayName(scope, i18n.language)}
                                </span>
                                {isSelected && (
                                  <Icon
                                    name="check"
                                    size="sm"
                                    className="shrink-0"
                                    aria-hidden="true"
                                  />
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {hint && (
                        <p className="px-2 pt-1 text-xs text-gray-500 dark:text-gray-400">{hint}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Tools Section */}
          {hasTools && (toolsLoading || toolCount > 0) && (
            <div className="p-3">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
                {t('tools.enableDisable', 'Tools')}
              </h3>

              {toolsLoading ? (
                <div className="text-sm text-gray-500 dark:text-gray-400">
                  {t('common.loading', 'Loading...')}
                </div>
              ) : (
                <div className="space-y-2">
                  {/* Grouped tools */}
                  {grouped.map(group => {
                    const allEnabled = group.matchedTools.every(t => enabledTools.includes(t));
                    const someEnabled = group.matchedTools.some(t => enabledTools.includes(t));
                    const groupName =
                      typeof group.name === 'object'
                        ? group.name[t('common.language', 'en')] || group.name.en
                        : group.name;
                    const groupDesc =
                      typeof group.description === 'object'
                        ? group.description[t('common.language', 'en')] || group.description.en
                        : group.description;

                    return (
                      <div
                        key={group.id}
                        role="menuitemcheckbox"
                        aria-checked={allEnabled ? 'true' : someEnabled ? 'mixed' : 'false'}
                        tabIndex={navTabIndex(`group-${group.id}`)}
                        className="flex items-center justify-between p-2 hover:bg-gray-50 dark:hover:bg-gray-700 focus:bg-gray-50 dark:focus:bg-gray-700 focus:ring-2 focus:ring-indigo-500 focus:ring-inset rounded-lg"
                        onClick={() => toggleTool(group.id, true, group.matchedTools)}
                        onKeyDown={e => {
                          if (e.key === ' ') {
                            e.preventDefault();
                            toggleTool(group.id, true, group.matchedTools);
                          }
                        }}
                      >
                        <div className="flex-1 min-w-0 mr-3">
                          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                            {groupName}
                          </div>
                          {groupDesc && (
                            <div
                              className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 line-clamp-1"
                              title={groupDesc}
                            >
                              {groupDesc}
                            </div>
                          )}
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={allEnabled}
                            ref={el => {
                              if (el) el.indeterminate = someEnabled && !allEnabled;
                            }}
                            onChange={() => toggleTool(group.id, true, group.matchedTools)}
                            className="sr-only peer"
                          />
                          <div className="w-11 h-6 bg-gray-200 peer-focus:outline-hidden peer-focus:ring-4 peer-focus:ring-indigo-300 dark:peer-focus:ring-indigo-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:rtl:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:inset-s-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-indigo-600"></div>
                        </label>
                      </div>
                    );
                  })}

                  {/* Individual tools */}
                  {individual.map(toolId => {
                    const toolInfo = availableTools.find(t => t.id === toolId);
                    const toolName = toolInfo?.name || toolId;
                    const toolDescription = toolInfo?.description;
                    const isEnabled = enabledTools.includes(toolId);

                    return (
                      <div
                        key={toolId}
                        role="menuitemcheckbox"
                        aria-checked={isEnabled}
                        tabIndex={navTabIndex(`tool-${toolId}`)}
                        className="flex items-center justify-between p-2 hover:bg-gray-50 dark:hover:bg-gray-700 focus:bg-gray-50 dark:focus:bg-gray-700 focus:ring-2 focus:ring-indigo-500 focus:ring-inset rounded-lg"
                        onClick={() => toggleTool(toolId)}
                        onKeyDown={e => {
                          if (e.key === ' ') {
                            e.preventDefault();
                            toggleTool(toolId);
                          }
                        }}
                      >
                        <div className="flex-1 min-w-0 mr-3">
                          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                            {toolName}
                          </div>
                          {toolDescription && (
                            <div
                              className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 line-clamp-1"
                              title={toolDescription}
                            >
                              {toolDescription}
                            </div>
                          )}
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={isEnabled}
                            onChange={() => toggleTool(toolId)}
                            className="sr-only peer"
                          />
                          <div className="w-11 h-6 bg-gray-200 peer-focus:outline-hidden peer-focus:ring-4 peer-focus:ring-indigo-300 dark:peer-focus:ring-indigo-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:rtl:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:inset-s-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-indigo-600"></div>
                        </label>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default ChatInputActionsMenu;
