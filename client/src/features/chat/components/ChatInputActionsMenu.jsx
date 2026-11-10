// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { SwitchIndicator } from '../../../shared/components/Switch';
import { VoiceInputComponent } from '../../voice/components';
import MagicPromptLoader from '../../../shared/components/MagicPromptLoader';
import ImageGenerationControls from './ImageGenerationControls';
import { useEmbeddedHost } from '../../office/contexts/EmbeddedHostContext';
import { useKeyboardNavigation } from '../../../shared/hooks/useKeyboardNavigation';
import { modelSupportsWebSearch } from '../webSearch';
import IntegrationPicker, {
  IntegrationPickerSearch
} from '../../integrations/picker/IntegrationPicker';
import { isRowOn, scopeMapOf } from '../../integrations/picker/pickerState';
import { saveIntegrationDefault } from '../../integrations/picker/useIntegrationDefaults';
import ProjectKnowledgeSection, {
  projectKnowledgeMatches
} from '../../projects/components/ProjectKnowledgeSection';

/**
 * The "+" menu of the chat input. Its main part is the integrations picker
 * (#2923, `IntegrationPicker`): attach, the integrations used in this chat
 * (rows from the server, one per integration), web search and image
 * generation, and the way to the integration settings. On a phone it also
 * holds the quick actions the desktop shows inline (magic prompt, voice).
 *
 * On/off rows (message context, web search, integrations) are
 * `menuitemcheckbox` items of the `role="menu"`: the row owns the state
 * (`aria-checked`), the focus and Space/Enter. The switch drawn in a row is a
 * visual only ({@link SwitchIndicator}): a real `Switch` (or checkbox) inside
 * a menu item would be a nested interactive control.
 */
function ChatInputActionsMenu({
  app,
  enabledTools,
  onEnabledToolsChange,
  // The picker rows (`useIntegrationPicker`): `{ rows, loading, connect }`.
  picker = null,
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
  // `integrationScopes` is `useIntegrationScopes().integrations`; a row with a
  // scope shows it and opens a submenu to change it.
  integrationScopes = null,
  onIntegrationScopeChange = null,
  // How the chat reaches its projects' knowledge (`useProjectKnowledgeMenu`);
  // null when the chat has no project or there is nothing to choose.
  projectKnowledge = null
}) {
  const { t } = useTranslation();
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
  const [query, setQuery] = useState('');
  const dropdownRef = useRef(null);
  const actionsMenuRef = useRef(null);
  const triggerRef = useRef(null);

  /** Closes the actions menu dropdown */
  const handleActionsMenuClose = useCallback(() => setIsOpen(false), []);

  useKeyboardNavigation(actionsMenuRef, {
    isActive: isOpen,
    onClose: handleActionsMenuClose
  });

  // A one-shot action (a pick, an upload) closes the menu and gives the focus
  // back to "+".
  const done = useCallback(() => {
    setIsOpen(false);
    triggerRef.current?.focus();
  }, []);

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

  // The storage providers the app binds and the user's groups grant
  // (`useFileUploadHandler().createUploadConfig` → `cloudStorage.providers`)
  const enabledCloudProviders = uploadConfig?.cloudStorage?.providers || [];
  const rows = Array.isArray(picker?.rows) ? picker.rows : [];
  const hasTools = enabledTools !== null && (rows.length > 0 || picker?.loading === true);
  const offCount = hasTools ? rows.filter(row => !isRowOn(row, enabledTools)).length : 0;
  // Not offered on a model web search does not work with: no native search
  // there and no engine available (the server's `websearchAvailability`).
  const hasWebsearch =
    app?.websearch?.enabled === true &&
    typeof onWebsearchEnabledChange === 'function' &&
    modelSupportsWebSearch(app, model) !== false;
  const scopeIntegrations = (Array.isArray(integrationScopes) ? integrationScopes : []).filter(
    integration => integration.scopePicker !== 'hidden' && integration.scopes?.length > 0
  );
  const hasScopes = scopeIntegrations.length > 0 && onIntegrationScopeChange !== null;
  const hasImageGeneration = model?.supportsImageGeneration === true;
  const hasProjectKnowledge = projectKnowledge !== null;

  // Local upload covers the paper-clip / drop-zone affordance. Cloud storage
  // providers are rendered separately so they must remain available even when
  // local upload is disabled (issue #1426).
  const localUploadEnabled = uploadConfig?.localUploadEnabled === true;
  const hasCloudProviders = enabledCloudProviders.length > 0;

  // Quick actions: on a phone they live in the menu, on a desktop inline.
  const quickActionCount =
    (localUploadEnabled ? 1 : 0) +
    (magicPromptEnabled && !showUndoMagicPrompt ? 1 : 0) +
    (showUndoMagicPrompt ? 1 : 0) +
    (onVoiceInput ? 1 : 0);

  const hasHostContextToggles = hostContextToggles.length > 0;
  // What the picker shows on every screen size.
  const hasPicker =
    hasTools ||
    hasWebsearch ||
    hasScopes ||
    hasCloudProviders ||
    hasImageGeneration ||
    hasProjectKnowledge;
  const hasActions = hasPicker || hasHostContextToggles || quickActionCount > 0;

  if (!hasActions) return null;

  // Single action optimization: if we have exactly one action and no picker,
  // render that action directly without a menu
  if (!hasPicker && !hasHostContextToggles && quickActionCount === 1) {
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

  // The phone-only quick actions (the desktop shows them inline). Upload is
  // one of them only without the picker, whose "Attach" section has it.
  const phoneUpload = localUploadEnabled && !hasPicker;
  const hasPhoneQuickActions =
    phoneUpload ||
    (magicPromptEnabled && !showUndoMagicPrompt) ||
    showUndoMagicPrompt ||
    Boolean(onVoiceInput);
  // On a desktop the "+" only shows when the menu has something for it.
  const hasDesktopMenuContent = hasPicker || hasHostContextToggles;
  const busy = Boolean(disabled || isProcessing);

  // The user's default for new chats of the app: what this chat uses now.
  const saveDefault =
    app?.id && typeof onEnabledToolsChange === 'function'
      ? () =>
          saveIntegrationDefault(app.id, {
            enabledTools,
            ...(hasWebsearch ? { websearchEnabled: Boolean(websearchEnabled) } : {}),
            integrationScopes: scopeMapOf(scopeIntegrations)
          })
      : null;

  const focusFirstItem = () => {
    const first = actionsMenuRef.current?.querySelector(
      '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]'
    );
    first?.focus();
  };

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Show + button on mobile always, on desktop only if menu has content */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          setQuery('');
          setIsOpen(!isOpen);
        }}
        className={`p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors ${
          isOpen ? 'bg-gray-100 dark:bg-gray-700' : ''
        } md:${hasDesktopMenuContent ? 'block' : 'hidden'}`}
        title={t('chatActions.menu', 'Actions menu')}
        aria-label={t('chatActions.menu', 'Actions menu')}
        aria-haspopup="menu"
        aria-expanded={isOpen}
      >
        <Icon name="plus-circle" size="md" />
        {offCount > 0 && (
          <span
            aria-hidden="true"
            className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full border border-white dark:border-gray-800"
          ></span>
        )}
      </button>

      {isOpen && (
        <div className="absolute bottom-full left-0 mb-2 w-80 max-w-[calc(100vw-2rem)] bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50">
          {hasPicker && (
            <IntegrationPickerSearch
              value={query}
              onChange={setQuery}
              onArrowDown={focusFirstItem}
              onClose={done}
            />
          )}
          <div
            ref={actionsMenuRef}
            role="menu"
            aria-label={t('chatActions.menu', 'Actions menu')}
            className="max-h-96 overflow-y-auto"
          >
            {/* Quick Actions Section - Hidden on desktop (md:) since actions are shown inline */}
            {hasPhoneQuickActions && (
              <div className="md:hidden p-3 border-b border-gray-200 dark:border-gray-700">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
                  {t('chatActions.quickActions', 'Quick Actions')}
                </h3>
                <div className="flex flex-wrap gap-2">
                  {phoneUpload && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onToggleUploader?.();
                        setIsOpen(false);
                      }}
                      disabled={busy}
                      title={t('chatActions.attachFile', 'Attach File')}
                      aria-label={t('chatActions.attachFile', 'Attach File')}
                      className="w-10 h-10 flex items-center justify-center bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 focus:bg-gray-200 dark:focus:bg-gray-600 focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800 rounded-lg disabled:opacity-50 transition-colors"
                    >
                      <Icon name="paper-clip" size="sm" />
                    </button>
                  )}

                  {magicPromptEnabled && !showUndoMagicPrompt && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onMagicPrompt?.();
                        setIsOpen(false);
                      }}
                      disabled={busy}
                      title={t('common.magicPrompt', 'Magic Prompt')}
                      aria-label={t('common.magicPrompt', 'Magic Prompt')}
                      className="w-10 h-10 flex items-center justify-center bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 focus:bg-gray-200 dark:focus:bg-gray-600 focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800 rounded-lg disabled:opacity-50 transition-colors"
                    >
                      {magicPromptLoading ? (
                        <MagicPromptLoader />
                      ) : (
                        <Icon name="sparkles" size="sm" />
                      )}
                    </button>
                  )}

                  {showUndoMagicPrompt && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onUndoMagicPrompt?.();
                        setIsOpen(false);
                      }}
                      disabled={busy}
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
                        disabled={busy}
                        onCommand={onVoiceCommand}
                      />
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Host context section — Outlook taskpane / browser extension */}
            {hasHostContextToggles && (
              <div
                className={`p-3 ${hasPicker ? 'border-b border-gray-200 dark:border-gray-700' : ''}`}
              >
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
                  {t('chat.input.contextSection', 'Message context')}
                </h3>
                <div className="space-y-1">
                  {hostContextToggles.map(toggle => {
                    const enabled = hostContextFlags?.[toggle.key] ?? toggle.defaultEnabled ?? true;
                    const flip = () => onHostContextFlagChange?.(toggle.key, !enabled);
                    return (
                      <div
                        key={toggle.key}
                        role="menuitemcheckbox"
                        aria-checked={enabled}
                        tabIndex={-1}
                        className="flex items-center justify-between p-2 hover:bg-gray-50 dark:hover:bg-gray-700 focus:bg-gray-50 dark:focus:bg-gray-700 focus:ring-2 focus:ring-indigo-500 focus:ring-inset rounded-lg cursor-pointer"
                        onClick={flip}
                        onKeyDown={e => {
                          if (e.key === ' ' || e.key === 'Enter') {
                            e.preventDefault();
                            flip();
                          }
                        }}
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
                        <SwitchIndicator checked={enabled} />
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {hasPicker && (
              <IntegrationPicker
                rows={rows}
                loading={picker?.loading === true}
                enabledTools={enabledTools}
                onEnabledToolsChange={onEnabledToolsChange}
                query={query}
                websearch={
                  hasWebsearch
                    ? {
                        available: true,
                        enabled: Boolean(websearchEnabled),
                        onChange: onWebsearchEnabledChange
                      }
                    : null
                }
                projectSection={
                  hasProjectKnowledge &&
                  projectKnowledgeMatches(t, query, projectKnowledge.value) ? (
                    <ProjectKnowledgeSection menu={projectKnowledge} onPicked={done} />
                  ) : null
                }
                scopeIntegrations={hasScopes ? scopeIntegrations : []}
                onScopeChange={hasScopes ? onIntegrationScopeChange : null}
                imageGeneration={
                  hasImageGeneration ? (
                    <ImageGenerationControls
                      app={app}
                      model={model}
                      imageAspectRatio={imageAspectRatio}
                      imageQuality={imageQuality}
                      onImageAspectRatioChange={onImageAspectRatioChange}
                      onImageQualityChange={onImageQualityChange}
                    />
                  ) : null
                }
                attach={{
                  localUploadEnabled,
                  onUpload: onToggleUploader,
                  cloudProviders: enabledCloudProviders,
                  onCloudProviderSelect
                }}
                onConnect={picker?.connect || null}
                onSaveDefault={saveDefault}
                disabled={busy}
                onDone={done}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default ChatInputActionsMenu;
