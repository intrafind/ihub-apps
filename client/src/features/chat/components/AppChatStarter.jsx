// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { fetchAppDetails, fetchModels } from '../../../api';
import useAuthKey from '../../../shared/hooks/useAuthKey';
import useFeatureFlags from '../../../shared/hooks/useFeatureFlags';
import useFileUploadHandler from '../../../shared/hooks/useFileUploadHandler';
import useMagicPrompt from '../../../shared/hooks/useMagicPrompt';
import { filterModelsForApp, pickInitialModelForApp } from '../../../utils/modelFiltering';
import { loadAppSettings } from '../../../utils/appSettings';
import useVoiceCommands from '../../voice/hooks/useVoiceCommands';
import { useChatAttachedProjects } from '../../projects/hooks/useChatAttachedProjects';
import { ATTACH_PROJECT_QUERY_PARAM } from '../../projects/utils/projectView';
import { appAllowsUserProjects } from '../../../../../shared/appProjects.js';
import { setPendingChatStart } from '../startChatHandoff';
import ChatInput from './ChatInput';

/**
 * Longest link (path and query) a chat may be started with. The first message
 * travels to the chat page in it (`?prefill=`), and the chat page drops it
 * again as soon as it has sent it. It stays under what a server accepts in a
 * request line next to the cookies; a message that would not fit shows an
 * error on Send instead of being cut. About 7,000 characters of ordinary
 * text; it stays under the request-line limit of common reverse proxies
 * (8 KB), which matters when the link is loaded before the chat page has
 * dropped `prefill` again (a reload, a restored tab).
 */
export const MAX_START_PATH_LENGTH = 7500;

/**
 * The chat input of an app, outside the app: the app's real input (uploads,
 * prompts, placeholder, input mode, model selector, tools, web search, magic
 * prompt, dictation) that starts a chat in the app on submit. The message
 * travels via `prefill` + `send=true` (so a reload or a shared link keeps
 * working), with the projects ticked in its project picker; the attachments and the toggles picked in the `+` menu ride on
 * the in-memory handoff (`setPendingChatStart`). Used by the start page and
 * the project page, so both offer the same input.
 *
 * @param {Object} props
 * @param {{id: string}|null} props.app - The app (an entry of the apps list).
 * @param {Object<string, string>} [props.startParams] - Query parameters every start
 *   carries before the message, e.g. `{ project: 'prj_…' }`.
 * @param {(appId: string) => void} [props.onBeforeStart] - Runs right before the chat
 *   page opens (e.g. to mint a fresh chat id).
 * @param {number} [props.maxPathLength] - Refuse a message whose start link would be
 *   longer (see {@link MAX_START_PATH_LENGTH}); no limit when omitted.
 * @param {boolean} [props.pickProjects=false] - Offer the project picker: the projects
 *   ticked here are attached to the chat (`?attachProject=`), where the app takes them.
 * @returns {JSX.Element|null}
 */
export default function AppChatStarter({
  app,
  startParams,
  onBeforeStart,
  maxPathLength,
  pickProjects = false
}) {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const authKey = useAuthKey();
  const featureFlags = useFeatureFlags();
  const navigate = useNavigate();

  const [draft, setDraft] = useState('');
  const [appDetails, setAppDetails] = useState(null);
  const [detailsFailed, setDetailsFailed] = useState(false);
  const [tooLong, setTooLong] = useState(false);
  // Models the viewer may use, tagged with the identity they were loaded for.
  const [modelsState, setModelsState] = useState({ key: null, models: [], loaded: false });
  const [selectedModel, setSelectedModel] = useState(null);

  // Per-chat feature toggles offered by the input's actions menu (the `+`).
  // This renders the app's real chat input, so it has to own this state
  // too — otherwise the menu shows the app's tools with no way to toggle them
  // and hides web search entirely (issue #2322). `null` for the tools means
  // "not resolved yet", matching AppChat's convention of passing `null` to
  // hide the tools section outright.
  const [enabledTools, setEnabledTools] = useState(null);
  const [websearchEnabled, setWebsearchEnabled] = useState(false);
  const [imageAspectRatio, setImageAspectRatio] = useState('1:1');
  const [imageQuality, setImageQuality] = useState('Medium');

  // The projects ticked in the input's project picker, for a chat that does
  // not exist yet: they ride on the start link. Kept across an app switch;
  // an app that takes no projects just does not get them.
  const [projectIds, setProjectIds] = useState([]);
  const attachedProjects = useChatAttachedProjects({
    chatId: null,
    stored: false,
    value: projectIds,
    onChange: setProjectIds
  });
  const projectsOffered = pickProjects && appAllowsUserProjects(appDetails);
  const projectContext = projectsOffered
    ? {
        chatId: null,
        stored: false,
        containerProjectId: null,
        value: projectIds,
        onChange: setProjectIds,
        disabled: false,
        attached: attachedProjects
      }
    : null;

  const inputRef = useRef(null);
  const formRef = useRef(null);
  const fileUploadHandler = useFileUploadHandler();
  const { setSelectedFile } = fileUploadHandler;

  // Voice dictation handler — writes the transcript into the draft, mirroring
  // the in-app chat behaviour.
  const { handleVoiceInput, handleVoiceCommand } = useVoiceCommands({
    setInput: setDraft,
    currentText: draft,
    sendMessage: () => formRef.current?.requestSubmit?.()
  });

  // Load the full app config so the chat input renders exactly what the app
  // is configured for (uploads, input mode, placeholder, etc.). Switching to
  // another app drops what was picked for the previous one: the attachment
  // (what it accepts may differ) and the model, so the new app starts on its
  // own preferred model rather than one the user never chose for it.
  useEffect(() => {
    setDetailsFailed(false);
    setAppDetails(null);
    setSelectedFile(null);
    setSelectedModel(null);
    setTooLong(false);
    if (!app?.id) return;
    let mounted = true;
    fetchAppDetails(app.id)
      .then(details => {
        if (!mounted) return;
        if (details) setAppDetails(details);
        else setDetailsFailed(true);
      })
      .catch(() => {
        // Don't leave the skeleton pulsing forever — offer the app link instead.
        if (mounted) setDetailsFailed(true);
      });
    return () => {
      mounted = false;
    };
  }, [app?.id, setSelectedFile]);

  // Load models so the input can offer the model selector when the app
  // allows it (mirrors the in-app chat). The list is permission-filtered per
  // viewer, so wait for authentication to resolve and reload it whenever the
  // viewer signs in or out — the page stays mounted across a sidebar
  // sign-in, so a one-off fetch would keep showing the anonymous list.
  useEffect(() => {
    if (!authKey) return undefined; // auth still resolving
    let mounted = true;
    fetchModels()
      .then(data => {
        if (mounted) {
          setModelsState({ key: authKey, models: Array.isArray(data) ? data : [], loaded: true });
        }
      })
      .catch(() => {
        if (mounted) setModelsState({ key: authKey, models: [], loaded: true });
      });
    return () => {
      mounted = false;
    };
  }, [authKey]);

  // Only trust a list that was loaded for the current identity.
  const modelsLoaded = modelsState.key === authKey && modelsState.loaded;

  // Models the app is actually allowed to use (from the list loaded for the
  // current identity only).
  const compatibleModels = useMemo(() => {
    if (!appDetails || modelsState.key !== authKey) return [];
    return filterModelsForApp(modelsState.models, appDetails);
  }, [modelsState, authKey, appDetails]);

  // Pick an initial model once the app + models are available.
  useEffect(() => {
    if (!appDetails || compatibleModels.length === 0) return;
    setSelectedModel(prev => {
      if (prev && compatibleModels.some(m => m.id === prev)) return prev;
      return pickInitialModelForApp(compatibleModels, appDetails) || compatibleModels[0].id;
    });
  }, [appDetails, compatibleModels]);

  // Seed the actions-menu toggles from the app config, then let anything the
  // user already chose for this app in the current session win — the same
  // precedence `useAppSettings` applies inside the app, so the `+` menu shows
  // the same state on both surfaces.
  useEffect(() => {
    if (!appDetails) {
      setEnabledTools(null);
      return;
    }
    const saved = loadAppSettings(appDetails.id) || {};
    setEnabledTools(
      Array.isArray(saved.enabledTools) ? saved.enabledTools : appDetails.tools || []
    );
    setWebsearchEnabled(saved.websearchEnabled ?? appDetails.websearch?.enabledByDefault ?? false);
    setImageAspectRatio(saved.imageAspectRatio || appDetails.imageGeneration?.aspectRatio || '1:1');
    setImageQuality(saved.imageQuality || appDetails.imageGeneration?.quality || 'Medium');
  }, [appDetails]);

  // Platform-wide kill switch for tools, mirroring AppChat: `null` keeps the
  // tools section out of the actions menu entirely.
  const toolsFeatureEnabled = featureFlags.isEnabled('tools', true);
  const effectiveEnabledTools = toolsFeatureEnabled ? enabledTools : null;

  // Magic prompt rewrites the draft in place, exactly as it does in the app.
  const magicPromptHandler = useMagicPrompt();
  const magicPromptEnabled = featureFlags.isAppFeatureEnabled(
    appDetails,
    'magicPrompt.enabled',
    false
  );
  const handleMagicPrompt = useCallback(async () => {
    const enhanced = await magicPromptHandler.handleMagicPrompt(draft, appDetails, appDetails?.id);
    if (enhanced) setDraft(enhanced);
  }, [draft, appDetails, magicPromptHandler]);
  const handleUndoMagicPrompt = useCallback(() => {
    const restored = magicPromptHandler.handleUndoMagicPrompt();
    if (restored !== null) setDraft(restored);
  }, [magicPromptHandler]);

  // Same rule as the in-app chat; ChatInput shows its "No models available"
  // notice when the list is empty, so a misconfigured group is visible rather
  // than silently hiding the selector. Kept hidden until the list has loaded.
  const showModelSelector =
    appDetails?.disallowModelSelection !== true &&
    appDetails?.settings?.model?.enabled !== false &&
    modelsLoaded;

  const micEnabled =
    (appDetails?.inputMode?.microphone?.enabled ?? appDetails?.microphone?.enabled) !== false;

  // The model object (not just its id) drives the image-generation controls and
  // the upload config's vision/audio gating, same as in the app chat.
  const selectedModelObject = useMemo(
    () => compatibleModels.find(m => m.id === selectedModel) || null,
    [compatibleModels, selectedModel]
  );

  const uploadConfig = useMemo(
    () =>
      appDetails
        ? fileUploadHandler.createUploadConfig(appDetails, selectedModelObject)
        : undefined,
    [appDetails, fileUploadHandler, selectedModelObject]
  );

  // Where the chat opens: the app, with the start parameters, the message
  // (sent at once) and the model picked here.
  const startPath = useCallback(
    (text = '') => {
      const params = new URLSearchParams(startParams || {});
      if (projectsOffered) {
        projectIds.forEach(id => params.append(ATTACH_PROJECT_QUERY_PARAM, id));
      }
      if (text) {
        params.set('prefill', text);
        params.set('send', 'true');
      }
      // Carry the chosen model so the app starts with the same selection.
      if (selectedModel && selectedModel !== appDetails?.preferredModel) {
        params.set('model', selectedModel);
      }
      const qs = params.toString();
      return `/apps/${encodeURIComponent(app.id)}${qs ? `?${qs}` : ''}`;
    },
    [app?.id, startParams, selectedModel, appDetails?.preferredModel, projectsOffered, projectIds]
  );

  const open = useCallback(
    path => {
      onBeforeStart?.(app.id);
      navigate(path);
    },
    [app?.id, navigate, onBeforeStart]
  );

  // Start the chat: carry the message via prefill+send (so refresh/shared links
  // work) and hand off any attachment payload through the in-memory bridge.
  const handleSubmit = useCallback(
    e => {
      if (e?.preventDefault) e.preventDefault();
      if (!app || !appDetails) return;
      const text = draft.trim();
      const hasFile = fileUploadHandler.selectedFile != null;
      if (!text && !hasFile && !appDetails.allowEmptyContent) return;

      const path = startPath(text);
      // Checked on Send, not while typing: the link is what would be too long.
      if (maxPathLength && path.length > maxPathLength) {
        setTooLong(true);
        return;
      }

      // Hand the app the toggles picked here (and any processed attachment) so
      // the auto-sent first message runs with the same features the user saw
      // in the `+` menu — issue #2322.
      setPendingChatStart({
        appId: app.id,
        ...(hasFile ? { files: fileUploadHandler.selectedFile } : {}),
        settings: {
          ...(effectiveEnabledTools !== null ? { enabledTools: effectiveEnabledTools } : {}),
          websearchEnabled,
          imageAspectRatio,
          imageQuality
        }
      });
      open(path);
    },
    [
      app,
      appDetails,
      maxPathLength,
      draft,
      fileUploadHandler,
      startPath,
      open,
      effectiveEnabledTools,
      websearchEnabled,
      imageAspectRatio,
      imageQuality
    ]
  );

  if (!app) return null;

  if (detailsFailed && !appDetails) {
    return (
      <button
        type="button"
        onClick={() => open(startPath())}
        className="w-full border-2 border-dashed border-gray-200 dark:border-gray-700 rounded-2xl bg-white dark:bg-gray-800 px-5 py-4 text-sm text-left text-gray-500 dark:text-gray-400 hover:border-indigo-300 dark:hover:border-indigo-600 transition-colors"
      >
        {t(
          'startPage.inputUnavailable',
          'The chat input could not be loaded. Open the app to start a conversation.'
        )}
      </button>
    );
  }

  if (!appDetails) {
    // Skeleton shaped like the chat input so the page doesn't flash a spinner.
    return (
      <div
        className="border-2 border-gray-200 dark:border-gray-700 rounded-2xl bg-white dark:bg-gray-800 px-5 py-4 animate-pulse"
        aria-hidden="true"
      >
        <div className="h-4 w-2/3 bg-gray-100 dark:bg-gray-700 rounded-sm mb-3" />
        <div className="flex items-center justify-between">
          <div className="h-7 w-7 bg-gray-100 dark:bg-gray-700 rounded-lg" />
          <div className="h-9 w-9 bg-gray-100 dark:bg-gray-700 rounded-xl" />
        </div>
      </div>
    );
  }

  return (
    <>
      <ChatInput
        app={appDetails}
        value={draft}
        onChange={e => {
          setDraft(e.target.value);
          setTooLong(false);
        }}
        onSubmit={handleSubmit}
        isProcessing={false}
        onCancel={() => {}}
        inputRef={inputRef}
        formRef={formRef}
        uploadConfig={uploadConfig}
        onFileSelect={fileUploadHandler.handleFileSelect}
        selectedFile={fileUploadHandler.selectedFile}
        showUploader={fileUploadHandler.showUploader}
        onToggleUploader={fileUploadHandler.toggleUploader}
        allowEmptySubmit={appDetails.allowEmptyContent || fileUploadHandler.selectedFile !== null}
        onVoiceInput={micEnabled ? handleVoiceInput : undefined}
        onVoiceCommand={micEnabled ? handleVoiceCommand : undefined}
        magicPromptEnabled={magicPromptEnabled}
        onMagicPrompt={handleMagicPrompt}
        showUndoMagicPrompt={magicPromptHandler.showUndoMagicPrompt}
        onUndoMagicPrompt={handleUndoMagicPrompt}
        magicPromptLoading={magicPromptHandler.magicLoading}
        enabledTools={effectiveEnabledTools}
        onEnabledToolsChange={toolsFeatureEnabled ? setEnabledTools : undefined}
        websearchEnabled={websearchEnabled}
        onWebsearchEnabledChange={appDetails.websearch?.enabled ? setWebsearchEnabled : undefined}
        model={selectedModelObject}
        imageAspectRatio={imageAspectRatio}
        imageQuality={imageQuality}
        onImageAspectRatioChange={setImageAspectRatio}
        onImageQualityChange={setImageQuality}
        models={compatibleModels}
        selectedModel={selectedModel}
        onModelChange={setSelectedModel}
        showModelSelector={showModelSelector}
        currentLanguage={currentLanguage}
        projectContext={projectContext}
      />
      {tooLong && (
        <p role="alert" className="mt-1 text-sm text-red-600 dark:text-red-400">
          {t('startPage.messageTooLong', 'This message is too long to send from here.')}
        </p>
      )}
    </>
  );
}
