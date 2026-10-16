import { useState, useEffect, useRef, useCallback, useMemo, Suspense } from 'react';
import { v4 as uuidv4 } from 'uuid';
import {
  getOrCreateChatId,
  mintChatId,
  readChatId,
  resetChatId,
  getConversationId,
  clearConversationId
} from '../../../utils/chatId';
import { getConversationMessages } from '../../../api/endpoints/apps';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { claimChatHandoff, fetchAppDetails, fetchChat } from '../../../api';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { buildPath } from '../../../utils/runtimeBasePath';
import { debugLog } from '../../../utils/debugLog';
import Icon from '../../../shared/components/Icon';
import ShareDialog from '../../chat/components/ShareDialog';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import { useOptionalAuth } from '../../../shared/contexts/authContextValue';
import lazyWithRetry from '../../../utils/lazyWithRetry';

// Import our custom hooks and components
import { fetchSourceFile } from '../../chat/sources/sourceActions';
import useAppChat from '../../chat/hooks/useAppChat';
import useVoiceCommands from '../../voice/hooks/useVoiceCommands';
import useAppSettings from '../../../shared/hooks/useAppSettings';
import useFileUploadHandler from '../../../shared/hooks/useFileUploadHandler';
import { consumePendingChatStart } from '../../chat/startChatHandoff';
import useMagicPrompt from '../../../shared/hooks/useMagicPrompt';
import { useIntegrationAuth } from '../../chat/hooks/useIntegrationAuth';
import useNextcloudEmbedAttachments from '../../nextcloud-embed/hooks/useNextcloudEmbedAttachments';
import useFeatureFlags from '../../../shared/hooks/useFeatureFlags';
import {
  invalidateChatsCache,
  useChatPersistence,
  useChatPersistenceResolving
} from '../../../shared/hooks/useChats';
import { ensureTokenizer, estimateTokensSync } from '../../../shared/utils/tokenEstimatorClient.js';
import ChatInput from '../../chat/components/ChatInput';
import ChatMessageList from '../../chat/components/ChatMessageList';
import CompareModeView from '../../chat/components/CompareModeView';
import StarterPromptsView from '../../chat/components/StarterPromptsView';
import GreetingView from '../../chat/components/GreetingView';
import NoMessagesView from '../../chat/components/NoMessagesView';
import InputVariables from '../../chat/components/InputVariables';
import ChatStartForm from '../../chat/components/ChatStartForm';
import UsageGuideButton from '../../chat/components/UsageGuideButton';
import useUsageGuide from '../../chat/hooks/useUsageGuide';
import {
  isStartFormEnabled,
  localizeVariables,
  renderStartFormPrompt,
  resolveVariableValues
} from '../../chat/utils/startForm';
import SharedAppHeader from '../components/SharedAppHeader';
import AIDisclaimerBanner from '../../chat/components/AIDisclaimerBanner';
import { recordAppUsage } from '../../../utils/recentApps';
import { saveAppSettings, loadAppSettings } from '../../../utils/appSettings';
import {
  processDocumentFile,
  decodeAudioFileToBuffer,
  recordingToAudioAttachment
} from '../../upload/utils/fileProcessing';
import { extractionOptionsOf } from '../../upload/utils/extractionOptions';
import { transcribeAudioBuffer } from '../../../utils/transcribeAudioBuffer';
import { getTranscriptionErrorMessage } from '../../../utils/transcriptionErrors';
import { startLiveTranscription } from '../../../utils/liveTranscription';
import { AudioBufferRecorder } from '../../../utils/audioRecorder';
import ScheduledRunBanner from '../../tasks/components/ScheduledRunBanner';

/**
 * Initialize variables with default values from app configuration
 * @param {Object} app - The app configuration
 * @param {string} currentLanguage - The current language
 * @returns {Object} - Object with initialized variables
 */
const getInitializedVariables = (app, currentLanguage) => {
  const initialVars = {};

  if (app && app.variables && Array.isArray(app.variables)) {
    app.variables.forEach(variable => {
      // For select variables with predefined values, ensure we store the value, not the label
      if (variable.predefinedValues && variable.defaultValue) {
        // If defaultValue is an object with language keys
        if (typeof variable.defaultValue === 'object') {
          const localizedLabel = getLocalizedContent(variable.defaultValue, currentLanguage);
          // Find the matching value for the localized label
          const matchingOption = variable.predefinedValues.find(
            option => getLocalizedContent(option.label, currentLanguage) === localizedLabel
          );
          // Use the value from predefined values if found, otherwise use the localized label
          initialVars[variable.name] = matchingOption ? matchingOption.value : localizedLabel;
        } else {
          // If defaultValue is a direct string, use it as is
          initialVars[variable.name] = variable.defaultValue;
        }
      } else if (variable.type === 'select' && variable.options) {
        // For select variables, handle options with localization
        let matchingOption = null;
        // Try to find option that matches defaultValue
        if (variable.defaultValue) {
          matchingOption = variable.options.find(option => option.value === variable.defaultValue);
        }

        // Get localized label if available
        const localizedLabel =
          typeof variable.label === 'object'
            ? getLocalizedContent(variable.label, currentLanguage)
            : variable.label || variable.name;

        // Use the value from predefined values if found, otherwise use the localized label
        initialVars[variable.name] = matchingOption ? matchingOption.value : localizedLabel;
      } else {
        // For other variables, use standard localization
        const localizedDefaultValue =
          typeof variable.defaultValue === 'object'
            ? getLocalizedContent(variable.defaultValue, currentLanguage)
            : variable.defaultValue || '';
        initialVars[variable.name] = localizedDefaultValue;
      }
    });
  }

  return initialVars;
};

const renderStartupState = (
  app,
  welcomeMessage,
  handleStarterPromptClick,
  hydrating,
  modeResolving,
  t,
  usageGuideHint = null
) => {
  // The app details can arrive before the platform config and the auth status
  // do, and until both have, nothing here knows whether this chat is
  // server-backed. Painting the greeting on that guess and correcting it a
  // frame later is a visible flicker, so this window renders nothing at all —
  // a spinner would only be a second flash for the installations that have no
  // persistence to wait for.
  if (modeResolving) return null;

  // A server-backed chat starts with an empty `messages` whether it is brand
  // new or holds a hundred turns — the difference only arrives with
  // `GET /api/chats/:id`. Greeting the user as if this were a new chat and then
  // swapping in the history a moment later is the flash this guard prevents.
  if (hydrating) {
    return <LoadingSpinner message={t('pages.appChat.loadingChat', 'Loading chat...')} />;
  }

  const starterPrompts = app?.starterPrompts || [];
  let view;
  if (starterPrompts.length > 0) {
    view = (
      <StarterPromptsView
        starterPrompts={starterPrompts}
        onSelectPrompt={handleStarterPromptClick}
      />
    );
  } else if (welcomeMessage) {
    view = <GreetingView welcomeMessage={welcomeMessage} />;
  } else {
    view = <NoMessagesView />;
  }
  if (!usageGuideHint) return view;
  return (
    <>
      {view}
      <div className="flex justify-center px-4 pb-4">{usageGuideHint}</div>
    </>
  );
};

// The query string an embedded chat reads: none. Module-level, so its identity
// is stable across renders like the router's own.
const NO_SEARCH_PARAMS = new URLSearchParams();

/** Whether a message is half of a transcription turn (its audio is not kept). */
const isTranscriptionTurn = (messages, messageId) =>
  messages.some(message => message.id === messageId && message.transcription);

/** A message can go out with text, attachments, or — where the app allows it — neither. */
const hasSomethingToSend = (content, files, app) =>
  Boolean(content) || files.length > 0 || app?.allowEmptyContent === true;

/** Attachments as the uploader holds them: none, one object, or a list. */
const asSelection = files => {
  if (files.length === 0) return null;
  return files.length === 1 ? files[0] : files;
};

/** A message's images, audio and documents (each one or a list) as one list. */
const attachmentsOf = ({ imageData, audioData, fileData }) =>
  [imageData, audioData, fileData].flatMap(data => (data ? [data].flat() : []));

/** The first non-empty text, trimmed ('' when there is none). */
const firstText = (...texts) => (texts.find(Boolean) || '').trim();

/** Stop a recorder and turn its recording into an audio attachment (null: nothing recorded). */
const recordedAttachment = async (recorder, fileName) => {
  const { audioBuffer } = await recorder.stop();
  return audioBuffer ? recordingToAudioAttachment(audioBuffer, fileName) : null;
};

/** The selection with one more attachment: a single one stays an object. */
const withAttachment = (held, attachment) => {
  const others = held ? [held].flat() : [];
  return others.length > 0 ? [...others, attachment] : attachment;
};

/** The name a file's transcription turn is shown under. */
const audioFileLabel = (file, fallback) =>
  (file.extractedFromVideo && file.originalVideoName) || file.fileName || fallback;

/** Release the microphone of a recording that is thrown away. */
const cancelRecording = recording => {
  if (recording?.kind === 'transcribe') recording.session.cancel();
  else if (recording?.kind === 'attach') recording.recorder.cancel();
};

// Longest audio sent to a transcription model (the server holds up to ~70
// minutes for a batch model and caps a session at 70 minutes).
const MAX_TRANSCRIPTION_SECONDS = 3600;
// Longest recording attached to a chat model that takes audio: it goes in the
// chat request as 16 kHz WAV (~1.9 MB a minute), within the request size limit.
const MAX_ATTACHED_RECORDING_SECONDS = 900;

// Loaded on first use: "Save as prompt" is one click among many, and the
// editor brings the apps list and the icon picker with it.
const PromptEditorModal = lazyWithRetry(() => import('../../prompts/components/PromptEditorModal'));
// Loaded on first use too: "Save as skill" only shows under a drafted skill.
const SkillEditorModal = lazyWithRetry(() => import('../../skills/components/SkillEditorModal'));
// Loaded on first use too: the usage guide opens in it only from a start form
// or compare mode.
const MarkdownViewer = lazyWithRetry(() => import('../../../shared/components/MarkdownViewer'));

/**
 * The chat page of an app.
 *
 * @param {Object} props
 * @param {Object|null} [props.preloadedApp] - App config already fetched by the caller
 * @param {boolean} [props.embedded=false] - Rendered inside another page instead of on
 *   the app's own route — the admin app editor's test panel (issue #2510). The app id
 *   comes from `appId`, the host page's URL is neither read nor changed, nothing
 *   navigates away from the host (canvas and "open in app" open a new tab), and
 *   nothing this browser remembers about the app is read or written: chat id,
 *   settings, variables, recent apps, the iAssistant conversation. Every mount is a
 *   new chat that starts from the app's own defaults, as a new user would see it.
 * @param {string|null} [props.appId] - The app to show when `embedded`
 */
function AppChat({ preloadedApp = null, embedded = false, appId: embeddedAppId = null }) {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const routeParams = useParams();
  // Embedded, the route and the query string belong to the host page.
  const appId = embedded ? embeddedAppId : routeParams.appId;
  const routeChatId = embedded ? undefined : routeParams.chatId;
  const navigate = useNavigate();
  const [urlSearchParams] = useSearchParams();
  const searchParams = embedded ? NO_SEARCH_PARAMS : urlSearchParams;
  // Embedded: where this app's own page lives, for links that must not point
  // at the host page.
  const appPagePath = embedded ? buildPath(`/apps/${encodeURIComponent(appId)}`) : null;
  const openInNewTab = useCallback(path => {
    window.open(buildPath(path), '_blank', 'noopener,noreferrer');
  }, []);
  const featureFlags = useFeatureFlags();
  const prefillMessage = searchParams.get('prefill') || '';
  const documentId = searchParams.get('documentId');
  const searchProfileParam = searchParams.get('searchProfile');
  const documentSource = searchParams.get('source');
  const [app, setApp] = useState(preloadedApp);
  const [input, setInput] = useState(prefillMessage);
  // Set by handleResendMessage once the resend content/variables/files have
  // been applied to state; the effect below fires the actual submit only
  // after React has committed that state, so handleSubmit's closure reads
  // the resent values instead of racing them (see handleResendMessage).
  const [pendingAutoSubmit, setPendingAutoSubmit] = useState(false);
  const [loading, setLoading] = useState(!preloadedApp);
  const [error, setError] = useState(null);
  const [showConfig, setShowConfig] = useState(false);
  const [variables, setVariables] = useState({});
  const [showParameters, setShowParameters] = useState(false);
  // The chat a message was last sent in. With a start form, it keeps the chat
  // a chat once the form is sent: regenerating or deleting the first exchange
  // empties the transcript, and the resend goes out through the composer.
  const [sentInChatId, setSentInChatId] = useState(null);
  // One share dialog for both: a short link to the app, and the stored
  // conversation itself as a read-only link. The latter is gated by the
  // server's answer (feature on, admin switch on, storage up) and needs a
  // durable chat.
  const [showShare, setShowShare] = useState(false);
  const auth = useOptionalAuth();
  // A short link belongs to the signed-in user who creates it.
  const signedOut = auth ? auth.isAuthenticated !== true : false;
  const shareEnabled = featureFlags.isBothEnabled(app, 'shortLinks', true) && !signedOut;
  const { platformConfig } = usePlatformConfig();
  const chatSharingEnabled = platformConfig?.chats?.sharing?.enabled === true;
  // "Save as prompt" on a sent message: offered to a signed-in user when the
  // installation lets users keep prompts of their own (#2519).
  const userPromptsEnabled =
    platformConfig?.userPrompts?.enabled === true && auth?.isAuthenticated === true;
  // Personal skills (own or shared) are offered in the `/` picker of every
  // app that does not opt out with `skillSettings.allowPersonal: false` —
  // also in apps without global skills of their own.
  const personalSkillsAvailable =
    platformConfig?.userSkills?.enabled === true &&
    auth?.isAuthenticated === true &&
    app?.skillSettings?.allowPersonal !== false;
  const [promptDraft, setPromptDraft] = useState(null);
  const [promptSavedNotice, setPromptSavedNotice] = useState(false);
  const handleSaveAsPrompt = useMemo(
    () =>
      userPromptsEnabled ? text => setPromptDraft({ prompt: text, appId: app?.id || null }) : null,
    [userPromptsEnabled, app?.id]
  );
  // "Save as skill" on an answer that drafts a skill (e.g. from the
  // skill-builder skill): the skill editor opens filled in. Offered to a
  // signed-in user when the installation lets users keep skills (the server's
  // `userSkills.enabled` already includes the skills feature).
  const userSkillsEnabled =
    platformConfig?.userSkills?.enabled === true && auth?.isAuthenticated === true;
  const [skillDraft, setSkillDraft] = useState(null);
  const [savedSkillName, setSavedSkillName] = useState(null);
  const handleSaveAsSkill = useMemo(
    () => (userSkillsEnabled ? draft => setSkillDraft(draft) : null),
    [userSkillsEnabled]
  );
  useEffect(() => {
    if (!savedSkillName) return undefined;
    const timer = setTimeout(() => setSavedSkillName(null), 5000);
    return () => clearTimeout(timer);
  }, [savedSkillName]);

  // Compare mode state
  // Check both platform-wide feature flag AND app-level setting
  const compareModeFeatureEnabled =
    featureFlags.isEnabled('compareMode', false) && app?.features?.compareMode?.enabled !== false;
  const [compareModeActive, setCompareModeActive] = useState(false);
  // Whether the start form has been sent to the compare panels. Entering or
  // leaving compare mode starts the panels afresh, and with them the form.
  const [compareFormSent, setCompareFormSent] = useState(false);
  const changeCompareMode = useCallback(active => {
    setCompareModeActive(active);
    setCompareFormSent(false);
  }, []);
  // Imperative handle exposed by CompareModeView for sendMessage / clearAll / cancelAll.
  const compareViewRef = useRef(null);
  // Each panel reports its processing state; compare mode is "processing" if any are active.
  const [panelProcessing, setPanelProcessing] = useState([false, false]);
  const compareIsProcessing = panelProcessing.some(Boolean);
  const handlePanelProcessingChange = useCallback((index, value) => {
    setPanelProcessing(prev => {
      if (prev[index] === value) return prev;
      const next = prev.slice();
      next[index] = value;
      return next;
    });
  }, []);

  // How the chat being opened was last answered — read from the stored chat
  // document on hydrate and handed to `useAppSettings` as its last layer, so
  // reopening a chat comes back with the websearch toggle, tools and style it
  // was using rather than the app's defaults. Null for a new chat, and reset
  // to null the moment the chat changes so one chat's setup never leaks into
  // the next.
  const [chatSettings, setChatSettings] = useState(null);
  // How the open chat came about (`origin` on the stored chat). A scheduled
  // run's chat shows the run header — task, time, status, approval.
  const [chatOrigin, setChatOrigin] = useState(null);

  // Shared app settings hook
  const {
    selectedModel,
    selectedStyle,
    selectedOutputFormat,
    temperature,
    sendChatHistory,
    ephemeral,
    thinkingEnabled,
    thinkingLevel,
    thinkingThoughts,
    enabledTools,
    websearchEnabled,
    imageAspectRatio,
    imageQuality,
    models,
    styles,
    setSelectedModel,
    setSelectedStyle,
    setSelectedOutputFormat,
    setTemperature,
    setSendChatHistory,
    setEphemeral,
    setThinkingEnabled,
    setThinkingLevel,
    setThinkingThoughts,
    setEnabledTools,
    setWebsearchEnabled,
    setImageAspectRatio,
    setImageQuality,
    modelsLoading
  } = useAppSettings(appId, app, { chatSettings, isolated: embedded, withTranscription: true });

  // When tools feature is disabled platform-wide, hide tool UI entirely
  const toolsFeatureEnabled = featureFlags.isEnabled('tools', true);
  const effectiveEnabledTools = toolsFeatureEnabled ? enabledTools : null;

  // Apply settings and variables from URL parameters once app data is loaded
  useEffect(() => {
    if (!app || modelsLoading) return;

    const newVars = {};
    let changed = false;

    const m = searchParams.get('model');
    if (m) {
      setSelectedModel(m);
      changed = true;
    }
    const st = searchParams.get('style');
    if (st) {
      setSelectedStyle(st);
      changed = true;
    }
    const out = searchParams.get('outfmt');
    if (out) {
      setSelectedOutputFormat(out);
      changed = true;
    }
    const tempParam = searchParams.get('temp');
    if (tempParam) {
      setTemperature(Number.parseFloat(tempParam));
      changed = true;
    }
    const hist = searchParams.get('history');
    if (hist) {
      setSendChatHistory(hist === 'true');
      changed = true;
    }

    searchParams.forEach((value, key) => {
      if (key.startsWith('var_')) {
        newVars[key.slice(4)] = value;
        changed = true;
      }
    });

    if (Object.keys(newVars).length) {
      setVariables(v => ({ ...v, ...newVars }));
    }

    if (changed) {
      const newSearch = new URLSearchParams(searchParams);
      [
        'model',
        'style',
        'outfmt',
        'temp',
        'history',
        'prefill',
        'send',
        ...Object.keys(newVars).map(v => `var_${v}`)
      ].forEach(k => newSearch.delete(k));
      navigate(`${window.location.pathname}?${newSearch.toString()}`, { replace: true });
    }
  }, [
    app,
    modelsLoading,
    navigate,
    searchParams,
    setSelectedModel,
    setSelectedOutputFormat,
    setSelectedStyle,
    setSendChatHistory,
    setTemperature
  ]);

  // State for managing parameter changes on mobile
  const [tempVariables, setTempVariables] = useState({});

  // State for document token size warning
  const [fileTokenWarning, setFileTokenWarning] = useState(null);

  // Record recent usage of this app. An admin testing it is not using it.
  useEffect(() => {
    if (!embedded) recordAppUsage(appId);
  }, [appId, embedded]);

  // Custom hooks for complex functionality
  const fileUploadHandler = useFileUploadHandler();
  const magicPromptHandler = useMagicPrompt();

  // True while audio is being transcribed (uploaded audio or video, or a
  // stopped recording finishing). Turns Send into Stop.
  const [isTranscribing, setIsTranscribing] = useState(false);

  // Aborts an in-flight upload/video transcription (the Stop button).
  const transcribeAbortRef = useRef(null);

  // Auto-attach files selected in Nextcloud (no-op outside the Nextcloud embed).
  const currentModelObject = useMemo(
    () => models?.find(m => m.id === selectedModel) || null,
    [models, selectedModel]
  );
  useNextcloudEmbedAttachments(fileUploadHandler, app, currentModelObject);
  // A transcription model selected in the model selector: audio and video are
  // its only input, and the transcript is its answer.
  const transcriptionModel =
    currentModelObject?.modelType === 'transcription' ? currentModelObject : null;
  // Compare mode sends one message to two models: chat models only.
  const chatModels = useMemo(
    () => (models || []).filter(m => m.modelType !== 'transcription'),
    [models]
  );

  // Consume the start-page handoff: the already-processed file payload plus the
  // feature toggles the user picked in that page's actions menu (web search,
  // tools, image settings — issue #2322). The message text and
  // auto-send still arrive via the `prefill` / `send=true` query params.
  //
  // Gated on `app && !modelsLoading` on purpose: `useAppSettings` seeds those
  // same values from the app config on exactly that gate, and its effect is
  // registered before this one, so applying here reliably lands *after* the
  // seeding instead of being overwritten by it.
  const handoffAppliedRef = useRef(false);
  useEffect(() => {
    handoffAppliedRef.current = false;
  }, [appId]);
  useEffect(() => {
    // Embedded: a handoff waiting in this tab is meant for the app's own page.
    if (embedded || handoffAppliedRef.current || !app || modelsLoading) return;
    const handoff = consumePendingChatStart(appId);
    handoffAppliedRef.current = true;
    if (!handoff) return;
    if (handoff.files) {
      fileUploadHandler.setSelectedFile(handoff.files);
    }
    const settings = handoff.settings;
    if (!settings) return;
    if (Array.isArray(settings.enabledTools)) setEnabledTools(settings.enabledTools);
    if (typeof settings.websearchEnabled === 'boolean')
      setWebsearchEnabled(settings.websearchEnabled);
    if (settings.imageAspectRatio) setImageAspectRatio(settings.imageAspectRatio);
    if (settings.imageQuality) setImageQuality(settings.imageQuality);
  }, [app, appId, modelsLoading, embedded]); // eslint-disable-line @eslint-react/exhaustive-deps

  // Check document token size against model context window and warn user if needed
  useEffect(() => {
    if (!fileUploadHandler.selectedFile) {
      setFileTokenWarning(null);
      return;
    }

    const currentModel = models?.find(m => m.id === selectedModel);
    if (!currentModel?.contextWindow) {
      setFileTokenWarning(null);
      return;
    }

    // Collect all document files (single or multiple)
    const files = Array.isArray(fileUploadHandler.selectedFile)
      ? fileUploadHandler.selectedFile
      : [fileUploadHandler.selectedFile];

    const documentFiles = files.filter(f => f.type === 'document' && f.content);
    if (documentFiles.length === 0) {
      setFileTokenWarning(null);
      return;
    }

    // Estimate token count per file using the shared tokenizer (gpt-tokenizer),
    // loaded lazily so it stays out of the eager bundle. This is a
    // cross-provider approximation; the provider-reported count after the turn
    // is authoritative.
    let cancelled = false;
    ensureTokenizer().then(() => {
      if (cancelled) return;
      const perFile = documentFiles.map((f, index) => ({
        fileName:
          f.fileName ||
          f.name ||
          t('common.untitledFile', 'Document {{index}}', { index: index + 1 }),
        estimatedTokens: estimateTokensSync(f.content || '')
      }));
      const totalEstimatedTokens = perFile.reduce((sum, f) => sum + f.estimatedTokens, 0);

      // Warn when document content alone would exceed 80% of the model's context
      // window. The estimate is the combined total across ALL attached documents.
      if (totalEstimatedTokens > currentModel.contextWindow * 0.8) {
        setFileTokenWarning({
          estimatedTokens: totalEstimatedTokens,
          contextWindow: currentModel.contextWindow,
          files: perFile
        });
      } else {
        setFileTokenWarning(null);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [fileUploadHandler.selectedFile, selectedModel, models, t]);

  // Integration authentication detection
  const {
    monitorChatMessages,
    connectIntegration,
    // checkConnectionStatus is available but not currently used
    getRequiredIntegrations
  } = useIntegrationAuth();

  const inputRef = useRef(null);
  const formRef = useRef(null);
  // The chat this page is showing. `/apps/:appId/c/:chatId` names one outright
  // — that is how the history opens a stored conversation — while `/apps/:appId`
  // falls back to the id this tab already holds for the app. State rather than a
  // ref, because changing it has to re-run the message hook, the stream state
  // and the hydration below.
  // Chat ids this tab minted itself. Such an id cannot exist in the durable
  // store by construction, so asking for it can only ever 404 — and that round
  // trip is paid for with a "Loading chat…" spinner where the greeting and the
  // starter prompts belong, plus a red `API Error` in the console every time.
  const mintedChatIdsRef = useRef(new Set());
  // Whether this viewer's chats are stored server-side. Read up here because it
  // decides what opening `/apps/:appId` means.
  const chatPersistence = useChatPersistence();
  // The new chat `/apps/:appId` shows while chats are durable, as
  // `{ appId, id }`. Opening an app starts a new chat then — the previous one
  // is a click away in the history — but re-resolving on the same visit must
  // not keep minting, so the id is held until the URL names a chat.
  const freshChatRef = useRef(null);
  // Embedded, the chat is never the one this tab holds for the app page, and
  // it is not stored for it either.
  const resolveChatId = useCallback(() => {
    if (routeChatId) {
      freshChatRef.current = null;
      return routeChatId;
    }
    if (!embedded && chatPersistence) {
      if (freshChatRef.current?.appId !== appId) {
        const minted = resetChatId(appId);
        mintedChatIdsRef.current.add(minted);
        freshChatRef.current = { appId, id: minted };
      }
      return freshChatRef.current.id;
    }
    // Without durable chats the transcript lives only in this tab, under the
    // id it holds for the app, so returning to the app has to find it again.
    const stored = embedded ? null : readChatId(appId);
    if (stored) return stored;
    const minted = embedded ? mintChatId() : getOrCreateChatId(appId);
    mintedChatIdsRef.current.add(minted);
    return minted;
  }, [appId, routeChatId, embedded, chatPersistence]);
  const [chatId, setChatId] = useState(resolveChatId);
  // Ref to store variables for resend operations to avoid race condition with state updates
  const pendingVariablesRef = useRef(null);

  // Follow the URL: another app, or another chat under the same app. An
  // embedded chat has no URL to follow; it keeps the chat it was mounted with.
  useEffect(() => {
    if (embedded) return;
    const next = resolveChatId();
    setChatId(current => (current === next ? current : next));
  }, [resolveChatId, embedded]);

  /**
   * Leave the current chat and start a fresh one for this app. A URL that names
   * a stored chat has to be dropped along with it, or the effect above would
   * immediately pin the chat that was just left. Nothing is lost when chats are
   * persisted — the old one simply stays in the history.
   *
   * @returns {string} The new chat id.
   */
  const startNewChat = useCallback(() => {
    const nextChatId = embedded ? mintChatId() : resetChatId(appId);
    // Minted here, so the store has never heard of it: skip the hydration
    // round trip that could only 404.
    mintedChatIdsRef.current.add(nextChatId);
    // Leaving `/c/:chatId` below re-resolves the chat; this is the one it
    // has to land on.
    if (!embedded) freshChatRef.current = { appId, id: nextChatId };
    setChatId(nextChatId);
    if (routeChatId) navigate(`/apps/${appId}`, { replace: true });
    return nextChatId;
  }, [appId, navigate, routeChatId, embedded]);

  /**
   * Determine if the response should trigger auto-redirect to canvas mode
   * Simplified to check if canvas is enabled and response is substantial
   * @param {string} response - The AI response content
   * @param {string} userInput - The user's input that triggered the response
   * @returns {boolean} True if should redirect to canvas
   */
  const shouldAutoRedirectToCanvas = useCallback(
    (response, userInput) => {
      debugLog('🔍 shouldAutoRedirectToCanvas check:', {
        hasResponse: !!response,
        responseLength: response?.length || 0,
        hasUserInput: !!userInput,
        hasApp: !!app,
        canvasEnabled: app?.features?.canvas
      });

      if (!response || !userInput || !app) return false;
      const shouldRedirect = response.length > 200 && app?.features?.canvas === true;

      debugLog('📋 Auto-redirect decision:', {
        shouldRedirect,
        responseLength: response.length,
        canvasEnabled: app?.features?.canvas
      });
      return shouldRedirect;
    },
    [app]
  );

  // Handle opening content in canvas mode
  const handleOpenInCanvas = useCallback(
    content => {
      if (!content || !app) return;

      const encodedContent = encodeURIComponent(content);
      const canvasPath = `/apps/${appId}/canvas?content=${encodedContent}`;
      if (embedded) openInNewTab(canvasPath);
      else navigate(canvasPath);
    },
    [navigate, appId, app, embedded, openInNewTab]
  );

  // Handle auto-redirect to canvas when message is completed
  const handleMessageComplete = useCallback(
    (aiResponse, userInput) => {
      debugLog('🎯 handleMessageComplete called:', {
        responseLength: aiResponse?.length || 0,
        userInput,
        canvasEnabled: app?.features?.canvas,
        shouldRedirect: shouldAutoRedirectToCanvas(aiResponse, userInput)
      });

      // Check if we should auto-redirect to canvas mode. Embedded, that would
      // be an unasked-for new tab; the canvas button still opens one.
      if (!embedded && shouldAutoRedirectToCanvas(aiResponse, userInput)) {
        debugLog('🎨 Auto-redirecting to canvas mode with response:', {
          responseLength: aiResponse?.length,
          userInput
        });
        handleOpenInCanvas(aiResponse);
      }
    },
    [shouldAutoRedirectToCanvas, handleOpenInCanvas, app, embedded]
  );

  // Durable chats: the server owns the transcript, so the browser copy is
  // skipped, a turn posts only the new message, and a past conversation gets
  // back on screen through the hydration below. Incognito switches it off for
  // this chat; anonymous viewers and installations without the capability never
  // had it, and keep exactly the behaviour they have today.
  // A chat handed over from the Outlook pane (below) was not stored there and
  // has no server-side history to continue from, so it carries its history
  // itself, like any chat that is not stored — whatever this viewer's chats
  // usually are. Only that chat: the next one is stored again as usual.
  const [handedOffChatId, setHandedOffChatId] = useState(null);
  const serverBackedChat = chatPersistence && !ephemeral && chatId !== handedOffChatId;
  // `chatPersistence` answers false until the platform config and the auth
  // status have both landed, so an early false is "not known yet", not "no".
  // The startup state has to wait it out, or a persisted chat greets the user
  // for a frame before its history arrives.
  const chatModeResolving = useChatPersistenceResolving() && !ephemeral;

  const {
    messages,
    hydrating,
    finishHydration,
    processing,
    clarificationPending,
    sendMessage: sendChatMessage,
    resendMessage: prepareResend,
    deleteMessage,
    editMessage,
    clearMessages,
    cancelGeneration,
    addSystemMessage,
    submitClarificationResponse,
    conversationTitle,
    loadServerMessages,
    reattachToRun,
    resetConversationState,
    addUserMessage,
    addAssistantMessage,
    updateAssistantMessage,
    removeMessage
  } = useAppChat({
    appId,
    chatId,
    onMessageComplete: handleMessageComplete,
    // A turn that starts is already in the store: a new chat belongs in the
    // history (running) now, not when its answer lands — which for a long
    // workflow is minutes away, and never happens here if the user leaves.
    onRunStarted: () => {
      if (serverBackedChat) invalidateChatsCache();
    },
    // Embedded, the app page's iAssistant conversation stays untouched.
    persistConversationId: !embedded,
    // Runtime-selectable: seeded from app.ephemeral but the user can toggle it in
    // the chat settings. When on, nothing is persisted to browser storage.
    ephemeral,
    serverBacked: serverBackedChat
  });

  // Form-based start (issue #2581): a new chat — or a new comparison, whose
  // panels hold transcripts of their own — opens with the start form in place
  // of the composer, and the variables are asked for nowhere else.
  const startFormActive = isStartFormEnabled(app);
  const showStartForm =
    startFormActive &&
    (compareModeActive
      ? !compareFormSent
      : sentInChatId !== chatId && !messages.some(m => m.role === 'user'));
  const showVariablesPanel = app?.variables?.length > 0 && !startFormActive;
  // Whether the user may pick the model: in the composer, or on the start form.
  const modelSelectionAllowed =
    app?.disallowModelSelection !== true && app?.settings?.model?.enabled !== false;

  // A chat handed over from the Outlook pane ("Open in web app" on a chat that
  // is not stored server-side, see server/routes/chatHandoffs.js): the pane
  // parked its transcript and opened `/apps/:appId?handoff=<token>`. Claimed
  // once the app and the chat mode are settled, and continued as a new chat,
  // so the one this tab already had for the app is left as it was. The
  // transcript lands after the switch to the new chat has cleared the screen —
  // hence the pending ref, applied by the effect that follows the chat id.
  const handoffToken = searchParams.get('handoff');
  const handoffClaimedRef = useRef(null);
  const handoffSignInNoticeRef = useRef(null);
  const pendingHandoffRef = useRef(null);
  // Only the user who handed the chat over can claim it. A visitor who is not
  // signed in (anonymous access) is asked to sign in first; the address keeps
  // the token, so it is claimed on the way back from the sign-in.
  const handoffSignedIn = auth ? auth.isAuthenticated === true : true;
  useEffect(() => {
    if (embedded || !handoffToken || !app || modelsLoading || chatModeResolving) return;
    if (!handoffSignedIn) {
      if (handoffSignInNoticeRef.current === handoffToken) return;
      handoffSignInNoticeRef.current = handoffToken;
      addSystemMessage(
        t('pages.appChat.handoff.signIn', 'Sign in to continue the chat you opened from Outlook.'),
        true
      );
      return;
    }
    if (handoffClaimedRef.current === handoffToken) return;
    handoffClaimedRef.current = handoffToken;
    // Single-use: once the server has answered for good, a reload must not
    // try it again. A failure that may pass (offline, a server error) keeps
    // the token in the address, so a reload retries.
    const dropTokenFromAddress = () => {
      const newSearch = new URLSearchParams(window.location.search);
      newSearch.delete('handoff');
      const query = newSearch.toString();
      navigate(`${window.location.pathname}${query ? `?${query}` : ''}`, { replace: true });
    };

    claimChatHandoff(handoffToken)
      .then(handoff => {
        dropTokenFromAddress();
        const handedMessages = Array.isArray(handoff?.messages) ? handoff.messages : [];
        if (handedMessages.length === 0) return;
        const nextChatId = startNewChat();
        setHandedOffChatId(nextChatId);
        if (handoff.variables && typeof handoff.variables === 'object') {
          setVariables(v => ({ ...v, ...handoff.variables }));
        }
        pendingHandoffRef.current = {
          chatId: nextChatId,
          messages: handedMessages.map((message, index) => ({
            ...message,
            id: `handoff-${Date.now()}-${index}`
          }))
        };
      })
      .catch(error => {
        const status = error?.status;
        if (status === 403 || status === 404) dropTokenFromAddress();
        addSystemMessage(
          status === 403
            ? t(
                'pages.appChat.handoff.otherUser',
                'This chat was opened from Outlook by another account. Sign in with that account to continue it.'
              )
            : status === 404
              ? t(
                  'pages.appChat.handoff.expired',
                  'The chat from Outlook could not be opened: the link has expired or was already used. Choose "Open in web app" in Outlook again.'
                )
              : t(
                  'pages.appChat.handoff.failed',
                  'The chat from Outlook could not be opened right now. Reload the page to try again.'
                ),
          true
        );
      });
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, [handoffToken, app, modelsLoading, chatModeResolving, embedded, handoffSignedIn]);
  useEffect(() => {
    const pending = pendingHandoffRef.current;
    if (!pending || pending.chatId !== chatId) return;
    pendingHandoffRef.current = null;
    loadServerMessages(pending.messages);
  }, [chatId, loadServerMessages]);

  // What an MCP App view in this chat may do in the composer: post a follow-up
  // message (`ui/message`) the way a starter prompt with autoSend does.
  const mcpAppHost = useMemo(
    () => ({
      sendMessage: text => {
        setInput(text);
        setTimeout(() => formRef.current?.requestSubmit(), 0);
      },
      isProcessing: processing
    }),
    [processing]
  );

  // A durable chat can be shared as a read-only link once it has a message.
  const chatShareOffered = chatSharingEnabled && serverBackedChat;
  const chatShareReady = chatShareOffered && Boolean(chatId) && messages.length > 0;

  // `/apps/:appId` always opens a new durable chat, so once this one has been
  // started the URL has to name it — otherwise a reload would leave it for a
  // blank one. Replaced rather than pushed: Back should lead to where the user
  // came from, not to an empty copy of this chat. Both routes render the same
  // element, so the running turn is not interrupted. Only the fresh chat of
  // this visit is pinned, and not while it hydrates: leaving `/c/:chatId` for
  // the bare route keeps the chat that was left — its id first, then its
  // messages — on screen for a render, and pinning it would send the user
  // straight back into it.
  const chatStarted = messages.some(message => message.role === 'user');
  useEffect(() => {
    if (
      embedded ||
      routeChatId ||
      !serverBackedChat ||
      hydrating ||
      !chatStarted ||
      chatId !== freshChatRef.current?.id
    )
      return;
    navigate(`/apps/${appId}/c/${chatId}`, { replace: true });
  }, [embedded, routeChatId, serverBackedChat, hydrating, chatStarted, appId, chatId, navigate]);

  // Hydrate a server-backed chat from the durable store. That mode keeps no
  // browser copy, so this fetch is the only thing that puts a stored transcript
  // back on screen — when the history opens a chat by URL and when a started
  // chat, pinned to its URL above, is reloaded. A chat
  // this tab minted but never sent is not in the store yet: that 404 is the
  // ordinary case for a new chat, not a failure worth reporting.
  useEffect(() => {
    // Switching chats drops the previous chat's setup immediately, rather than
    // waiting for the new one's document to arrive. In the gap the app's own
    // defaults apply, which is what a chat with no stored settings gets too —
    // leaving the old ones in place would answer the new chat with the
    // previous one's tools.
    setChatSettings(null);
    setChatOrigin(null);
  }, [chatId]);

  // The hydration attempt that owns the transcript, as `<chatId>|<mode>`. Keyed
  // on the mode too, because leaving and re-entering server-backed mode (the
  // incognito toggle) is a second entry into the same chat — a chat-id-only
  // guard would answer "already done" and then never fetch, never finish
  // hydrating, and leave the surface spinning "Loading chat…" for good.
  const chatHydratedRef = useRef(null);
  // Whether the fetch below is still out. A re-run of the effect must not end
  // hydration behind its back — that is the greeting flash all over again.
  const hydrationPendingRef = useRef(false);
  useEffect(() => {
    if (!serverBackedChat || !app) return undefined;
    const attempt = `${chatId}|${serverBackedChat}`;
    if (chatHydratedRef.current === attempt) {
      // This chat has already been fetched (or deliberately not fetched) in
      // this mode. Nothing else clears the loading flag, so say so here.
      if (!hydrationPendingRef.current) finishHydration();
      return undefined;
    }
    // Already showing a conversation: the browser copy that becoming
    // server-backed discards is cleared in the same commit, so a non-empty
    // transcript here is one that belongs on screen — an incognito stretch, or
    // a handoff that seeded it. Hydration is left alone rather than finished:
    // the clearing case re-runs this effect a frame later with nothing on
    // screen, and finishing here would uncover the greeting in between.
    if (messages.length > 0) return undefined;
    if (mintedChatIdsRef.current.has(chatId)) {
      // This tab minted the id, so the store has never heard of it: asking
      // would buy a guaranteed 404, a console error, and a spinner where the
      // greeting and the starter prompts belong.
      chatHydratedRef.current = attempt;
      hydrationPendingRef.current = false;
      finishHydration();
      return undefined;
    }
    chatHydratedRef.current = attempt;
    hydrationPendingRef.current = true;

    // Superseded only by another attempt — a different chat, or a mode change
    // — never by a re-render. A turn started during the round trip used to
    // cancel this fetch through the effect's own cleanup and, because the
    // guard above was already latched, the stored transcript was then lost for
    // the rest of the chat's life.
    const owns = () => chatHydratedRef.current === attempt;
    void (async () => {
      try {
        const result = await fetchChat(chatId);
        if (!owns()) return;
        // The store is the source of truth, so it replaces whatever is here —
        // and an empty transcript still ends the loading state rather than
        // letting the greeting appear a beat late. A turn started meanwhile is
        // kept, with the stored history restored in front of it.
        const storedMessages = Array.isArray(result?.messages) ? result.messages : [];
        loadServerMessages(storedMessages, { preserveLocal: true });
        // `modelId` lives on the chat document rather than inside `settings`,
        // so it is folded in here; `useAppSettings` still checks the app
        // allows it before selecting it.
        const stored = result?.chat?.settings;
        const storedModelId = result?.chat?.modelId;
        setChatSettings(
          stored || storedModelId
            ? { ...stored, ...(storedModelId ? { modelId: storedModelId } : {}) }
            : null
        );
        // The variables the chat was given, over the app's defaults: the
        // panel shows them again, and a start form's chat continues with them.
        if (result?.chat?.variables) setVariables(v => ({ ...v, ...result.chat.variables }));
        setChatOrigin(result?.chat?.origin || null);
        // Opening a chat is what "seen" means: this same GET cleared the
        // chat's unseen flag server-side, so every list already on screen is
        // now showing a badge the server no longer reports.
        invalidateChatsCache();

        // The turn may still be generating. A durable chat's run outlives the
        // browser that started it, so reopening the chat has to re-attach to
        // it — replay what the ledger already holds, then follow the stream —
        // or the answer only appears after the turn ends and the page is
        // loaded a second time. `onSettled` re-reads the transcript once it
        // finishes, because the store, not this surface, is what the answer
        // finally was.
        // ...unless its answer is already in the transcript we just read.
        // The server stores the answer *before* it releases the run — the two
        // take the chat lock separately, and the other order lets a reader see
        // a settled chat whose answer is not stored yet and clear the unseen
        // flag on it permanently. The cost of the safe order is this window:
        // `status` still says `running` while the reply is already here. Keying
        // off the status alone, the client renders the stored answer and then
        // mints a second bubble and replays the same tokens into it — and it
        // never recovers on its own, because the run has ended and `onSettled`
        // has no end to wait for, so `processing` sticks until a reload.
        const activeRunId =
          result?.chat?.status === 'running' ? result.chat.activeRunId || null : null;
        const answered =
          activeRunId !== null &&
          storedMessages.some(
            message => message.role === 'assistant' && message.runId === activeRunId
          );
        const runningRunId = answered ? null : activeRunId;
        if (runningRunId) {
          reattachToRun(runningRunId, {
            onSettled: async () => {
              if (!owns()) return;
              try {
                const settled = await fetchChat(chatId);
                if (!owns()) return;
                // Replaces the transcript outright, placeholder included: the
                // store now holds the assistant message this surface was
                // rendering live, and it is the version that survives a
                // reload.
                loadServerMessages(Array.isArray(settled?.messages) ? settled.messages : []);
                invalidateChatsCache();
              } catch (err) {
                // The live projection stays on screen. It is very probably
                // right — this re-read only exists to close the gap between
                // the replay and the stream.
                console.warn('Could not re-read the settled chat:', err.message);
              }
            }
          });
        }
      } catch (err) {
        if (!owns()) return;
        if (err?.status !== 404) {
          console.warn('Failed to load the stored chat, starting empty:', err.message);
        }
        finishHydration();
      } finally {
        if (owns()) hydrationPendingRef.current = false;
      }
    })();

    return undefined;
  }, [serverBackedChat, app, chatId, messages.length, loadServerMessages, finishHydration]);

  // A scheduled run that was waiting on this chat's approval finished on the
  // server: its answer is in the store, not on screen, so read it back — unless
  // the user moved to another chat meanwhile, whose transcript this is not.
  const currentChatIdRef = useRef(chatId);
  useEffect(() => {
    currentChatIdRef.current = chatId;
  }, [chatId]);
  const reloadScheduledRunChat = useCallback(async () => {
    if (!chatId) return;
    const requestedChatId = chatId;
    try {
      const result = await fetchChat(requestedChatId);
      if (currentChatIdRef.current !== requestedChatId) return;
      loadServerMessages(Array.isArray(result?.messages) ? result.messages : []);
      invalidateChatsCache();
    } catch (err) {
      console.warn('Could not re-read the chat after its scheduled run:', err.message);
    }
  }, [chatId, loadServerMessages]);

  // A finished turn is what changes the chat list: a brand-new chat appears in
  // it, an existing one moves to the top and may have gained a derived title,
  // and opening this chat cleared its unseen flag. The sidebar is mounted once
  // in Layout for the whole session, so without this its Recents would keep
  // showing the list it fetched when the page first loaded. Every terminal
  // branch of a turn clears `processing`, so the transition covers a failed
  // turn too — that one is stored as well.
  const wasProcessingRef = useRef(false);
  useEffect(() => {
    const wasProcessing = wasProcessingRef.current;
    wasProcessingRef.current = processing;
    if (serverBackedChat && wasProcessing && !processing) invalidateChatsCache();
  }, [processing, serverBackedChat]);

  // Resume conversation from conversation API on mount (iAssistant Conversation)
  const conversationResumed = useRef(false);
  useEffect(() => {
    if (conversationResumed.current || !app || messages.length > 0) return;
    // A server-backed chat hydrates from the durable store instead, and that
    // store is the source of truth for it. Two loaders replacing the same array
    // would race, and the loser would silently win on a slow network. An
    // embedded chat is always new.
    if (embedded || ephemeral || serverBackedChat) return;
    // A chat handed over from Outlook brings its own transcript: the
    // conversation this tab had for the app must not land on top of it.
    if (handoffToken || pendingHandoffRef.current || chatId === handedOffChatId) return;

    const existingConversationId = getConversationId(appId);
    if (!existingConversationId) return;

    conversationResumed.current = true;

    const requestedChatId = chatId;
    void (async () => {
      try {
        const result = await getConversationMessages(appId, existingConversationId, { chatId });
        // The chat may have changed meanwhile (a new chat, a hand-off).
        if (currentChatIdRef.current !== requestedChatId) return;
        const serverMessages = result?.messages || result;
        if (Array.isArray(serverMessages) && serverMessages.length > 0) {
          loadServerMessages(serverMessages);
        }
      } catch (err) {
        // Conversation may have been deleted or expired - clear stored ID
        console.warn('Failed to load conversation messages, clearing stored ID:', err.message);
        clearConversationId(appId);
      }
    })();
  }, [
    app,
    appId,
    chatId,
    messages.length,
    loadServerMessages,
    ephemeral,
    serverBackedChat,
    embedded,
    handoffToken,
    handedOffChatId
  ]);

  // Auto-send message if send=true query parameter is present
  const autoSendTriggered = useRef(false);
  // The intent has to be latched on the first render that sees it: the
  // URL-parameter effect above strips `send` and `prefill` as soon as it
  // applies anything, so by the time the settings below are ready the query
  // string no longer says the message should be sent.
  const autoSendPending = useRef(false);

  // Reset auto-send trigger when appId changes
  useEffect(() => {
    autoSendTriggered.current = false;
    autoSendPending.current = false;
  }, [appId]);

  useEffect(() => {
    if (searchParams.get('send') === 'true' && prefillMessage && !autoSendTriggered.current) {
      autoSendPending.current = true;
    }
    if (!autoSendPending.current || autoSendTriggered.current) return;
    if (!app || processing) return;
    // Wait for the model catalogue before firing. `useAppSettings` resolves
    // the app's initial model (and its temperature, output format, …) only
    // once the catalogue has loaded, and a model carried over from the start
    // page arrives via `?model=` which the URL-parameter effect above applies
    // on the same gate. Sending before that goes out as `modelId: null`,
    // which the server rejects with `400 Invalid request` — a race only slow
    // devices lost, so on a phone the handoff from the start page failed
    // while on a desktop the 100 ms below always covered it.
    if (modelsLoading || !selectedModel) return;

    autoSendTriggered.current = true;
    autoSendPending.current = false;

    // Clean up the send and prefill parameters from URL so a later reload
    // doesn't repopulate the input with the already-sent message
    const newSearch = new URLSearchParams(searchParams);
    newSearch.delete('send');
    newSearch.delete('prefill');
    navigate(`${window.location.pathname}?${newSearch.toString()}`, { replace: true });

    // A start form has no composer to submit: it shows the prefilled text and
    // sends it, as the template's {{content}}, once the form is filled in.
    if (showStartForm) return;

    // Trigger the form submission after a short delay to ensure everything is initialized
    setTimeout(() => {
      if (formRef.current) {
        formRef.current.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      }
    }, 100);
  }, [
    app,
    processing,
    prefillMessage,
    searchParams,
    navigate,
    modelsLoading,
    selectedModel,
    showStartForm
  ]);

  // Fetch and attach the document when navigated from "Open in App": the
  // source's provider (`source`), its id and scope, fetched through the one
  // provider route (`GET /api/sources/:provider/content`) with the user's own
  // permissions.
  const documentAttached = useRef(false);
  useEffect(() => {
    if (documentAttached.current || !app || !documentSource || !documentId) return;
    if (!/^[\w.-]{1,100}$/.test(documentSource)) return;

    documentAttached.current = true;
    const source = {
      provider: documentSource,
      ref: searchProfileParam ? { id: documentId, scope: searchProfileParam } : { id: documentId }
    };
    const displayType =
      documentSource === 'ifinder'
        ? 'iFinder Document'
        : t('sources.documentFromSource', 'Document');

    const fetchAndAttach = async () => {
      // Show loading placeholder immediately
      fileUploadHandler.setSelectedFile({
        type: 'document',
        source: documentSource,
        fileName: prefillMessage || t('attachedFiles.loading', 'Loading document...'),
        fileSize: 0,
        fileType: 'application/octet-stream',
        loading: true,
        displayType
      });

      try {
        const file = await fetchSourceFile(source, prefillMessage || 'document');

        // Process through the same pipeline as uploaded files
        const { content, pageImages } = await processDocumentFile(
          file,
          extractionOptionsOf(app?.upload?.fileUpload)
        );

        const fileData = {
          type: 'document',
          source: documentSource,
          content,
          pageImages: pageImages || [],
          fileName: file.name,
          fileSize: file.size,
          fileType: file.type,
          displayType
        };

        fileUploadHandler.setSelectedFile(fileData);
      } catch (err) {
        console.error('Failed to fetch and attach the document:', err);
        fileUploadHandler.clearSelectedFile();
      }

      // Clean source params from URL to prevent re-fetch
      const newSearch = new URLSearchParams(searchParams);
      ['documentId', 'searchProfile', 'source'].forEach(k => newSearch.delete(k));
      navigate(`${window.location.pathname}?${newSearch.toString()}`, { replace: true });
    };

    void fetchAndAttach();
  }, [
    app,
    documentSource,
    documentId,
    searchProfileParam,
    prefillMessage,
    fileUploadHandler,
    searchParams,
    navigate
  ]);

  // Auto-start conversation if app.autoStart is enabled
  const autoStartTriggered = useRef(false);

  // Reset auto-start trigger when appId or chatId changes
  useEffect(() => {
    autoStartTriggered.current = false;
  }, [appId, chatId]);

  // The latest values the delayed send below has to re-check. Hydration can
  // land inside those 300 ms, and the timer closes over nothing else.
  const autoStartGateRef = useRef(null);
  // A hand-off from Outlook is the chat's start: nothing may auto-start while
  // it is being claimed (the token stays in the address until it settles) or
  // until its transcript is on screen.
  const handoffInProgress = Boolean(handoffToken) || pendingHandoffRef.current !== null;
  autoStartGateRef.current = {
    hydrating,
    chatModeResolving,
    messageCount: messages.length,
    handoffInProgress
  };

  useEffect(() => {
    // Check if we should auto-start the conversation
    const shouldAutoStart =
      app?.autoStart === true && // App has autoStart enabled
      !isStartFormEnabled(app) && // A start form is sent by the user, not on open
      messages.length === 0 && // No messages yet
      // …and an empty transcript really does mean "new chat". In server-backed
      // mode it is also what a chat with a hundred stored turns looks like
      // until `GET /api/chats/:id` answers, so firing here would append a
      // blank turn — and re-prompt the model with the whole history — every
      // single time the user opens that chat from the history.
      !hydrating &&
      !chatModeResolving &&
      !handoffInProgress &&
      !processing && // Not currently processing
      !autoStartTriggered.current && // Haven't triggered yet
      selectedModel && // Model is selected
      app.variables; // Variables are initialized

    if (shouldAutoStart) {
      debugLog('Auto-starting conversation for app:', appId);
      autoStartTriggered.current = true;

      // Send an empty message to trigger the LLM
      // The empty user message will be filtered out in ChatMessageList
      setTimeout(() => {
        // Re-check: the stored transcript may have landed while this timer
        // was pending, and this was never a new chat after all.
        const gate = autoStartGateRef.current;
        if (
          gate.hydrating ||
          gate.chatModeResolving ||
          gate.handoffInProgress ||
          gate.messageCount > 0
        ) {
          debugLog('Auto-start abandoned: the chat is not empty after all');
          return;
        }
        const params = {
          modelId: selectedModel,
          style: selectedStyle,
          temperature,
          outputFormat: selectedOutputFormat,
          language: currentLanguage,
          ...(thinkingEnabled !== null ? { thinkingEnabled } : {}),
          ...(thinkingLevel !== null ? { thinkingLevel } : {}),
          ...(thinkingThoughts !== null ? { thinkingThoughts } : {}),
          ...(effectiveEnabledTools !== null && effectiveEnabledTools !== undefined
            ? { enabledTools: effectiveEnabledTools }
            : {}),
          ...(app?.websearch?.enabled ? { websearchEnabled } : {}),
          ...(imageAspectRatio ? { imageAspectRatio } : {}),
          ...(imageQuality ? { imageQuality } : {})
        };

        // Prepare validated variables
        const validatedVariables = {};
        if (app?.variables && app.variables.length > 0) {
          app.variables.forEach(varConfig => {
            const currentValue = variables[varConfig.name];
            const isEmptyOrWhitespace =
              currentValue === undefined ||
              currentValue === null ||
              (typeof currentValue === 'string' && currentValue.trim() === '');

            if (isEmptyOrWhitespace) {
              const defaultValue =
                typeof varConfig.defaultValue === 'object'
                  ? getLocalizedContent(varConfig.defaultValue, currentLanguage)
                  : varConfig.defaultValue || '';
              validatedVariables[varConfig.name] = defaultValue;
            } else {
              validatedVariables[varConfig.name] = currentValue;
            }
          });
        }

        // Send empty message to trigger auto-start
        sendChatMessage({
          displayMessage: {
            content: '', // Empty content - will be filtered out in ChatMessageList
            meta: {
              rawContent: '',
              variables:
                app?.variables && app.variables.length > 0 ? { ...validatedVariables } : undefined
            }
          },
          apiMessage: {
            content: '',
            promptTemplate: app?.prompt || null,
            variables: { ...validatedVariables },
            imageData: null,
            fileData: null
          },
          params,
          sendChatHistory,
          messageMetadata: {
            customResponseRenderer: app?.customResponseRenderer,
            outputFormat: selectedOutputFormat
          }
        });
      }, 300); // Small delay to ensure everything is initialized
    }
  }, [
    app,
    messages.length,
    hydrating,
    chatModeResolving,
    handoffInProgress,
    processing,
    appId,
    selectedModel,
    selectedStyle,
    temperature,
    selectedOutputFormat,
    sendChatHistory,
    currentLanguage,
    variables,
    thinkingEnabled,
    thinkingLevel,
    thinkingThoughts,
    effectiveEnabledTools,
    imageAspectRatio,
    imageQuality,
    sendChatMessage,
    getLocalizedContent
  ]);

  // Determine which integrations this app uses
  const appIntegrations = useMemo(() => {
    if (!app?.tools) return [];

    const integrations = [];

    // Check for JIRA tools
    if (app.tools.includes('jira')) {
      integrations.push('jira');
    }

    // Future integrations can be detected here
    // if (app.tools.some(tool => tool.startsWith('microsoft_'))) {
    //   integrations.push('microsoftGraph');
    // }

    return integrations;
  }, [app?.tools]);

  // Monitor messages for integration authentication errors
  useEffect(() => {
    monitorChatMessages(messages, appIntegrations);
  }, [messages, appIntegrations, monitorChatMessages]);

  // Get required integrations for display
  const requiredIntegrations = getRequiredIntegrations();

  // Set up voice commands
  const { handleVoiceInput, handleVoiceCommand } = useVoiceCommands({
    messages,
    clearChat: () => {
      cancelGeneration('voice');
      clearMessages();
      resetConversationState();
      startNewChat();
      if (!embedded) clearConversationId(appId);
      conversationResumed.current = false;

      // Reset the chat input to empty
      setInput('');

      // Clear any selected file and hide the uploader
      fileUploadHandler.clearSelectedFile();
      fileUploadHandler.hideUploader();

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
          variables: initialVars
        };
        if (!embedded) saveAppSettings(appId, settings);
      }
    },
    sendMessage: text => {
      setInput(text);
      setTimeout(() => {
        formRef.current?.requestSubmit();
      }, 0);
    },
    isProcessing: processing,
    currentText: input,
    setInput,
    onConfirmClear: () =>
      window.confirm(
        t('pages.appChat.confirmClear', 'Are you sure you want to clear the entire chat history?')
      )
  });

  // Get UI config for fallback to widget greeting

  useEffect(() => {
    // Store mounted state to prevent state updates after unmount
    let isMounted = true;

    const loadData = async () => {
      // Skip fetching if app data is already preloaded
      if (preloadedApp) {
        // Still initialize variables if needed
        if (preloadedApp.variables && isMounted) {
          const initialVars = getInitializedVariables(preloadedApp, currentLanguage);
          if (isMounted) {
            setVariables(initialVars);
          }
        }
        return;
      }

      try {
        setLoading(true);

        // Add a small delay to allow i18n to fully initialize
        await new Promise(resolve => setTimeout(resolve, 100));

        // Only proceed if still mounted
        if (!isMounted) return;

        debugLog('Fetching app data for:', appId);
        const appData = await fetchAppDetails(appId);

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
        console.error('Error loading app data:', err);
        if (isMounted) {
          setError(
            t('error.failedToLoadApp', 'Failed to load application data. Please try again later.')
          );
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    void loadData();

    // Cleanup function to handle component unmount
    return () => {
      isMounted = false;
    };
  }, [appId, currentLanguage, t, preloadedApp]);

  // Load saved variables from sessionStorage when initializing. Embedded, the
  // test shows the app's own defaults.
  useEffect(() => {
    if (app && !loading && !embedded) {
      const savedSettings = loadAppSettings(appId);
      if (savedSettings && savedSettings.variables) {
        setVariables(savedSettings.variables);
        debugLog('Restored app variables from sessionStorage:', savedSettings.variables);
      }
    }
  }, [app, loading, appId, embedded]);

  // Save variables to sessionStorage whenever they change
  useEffect(() => {
    if (app && !loading && !embedded) {
      const settings = {
        variables
      };

      saveAppSettings(appId, settings);
    }
  }, [app, loading, appId, variables, embedded]);

  // Calculate the welcome message to display (if any) - show greeting when configured
  const welcomeMessage = useMemo(() => {
    // Don't show welcome message if there are any messages, while the chat mode
    // is still unknown, or while a stored transcript is still on its way — see
    // renderStartupState.
    if (!app || loading || hydrating || chatModeResolving || messages.length > 0) return null;

    // Skip if starter prompts are configured - they take priority
    if (app.starterPrompts && app.starterPrompts.length > 0) {
      return null;
    }

    // Get the greeting message if configured
    const userLanguage = currentLanguage.split('-')[0].toLowerCase();

    let greeting = null;

    // Check if app has its own greeting
    if (app.greeting) {
      greeting =
        typeof app.greeting === 'object'
          ? app.greeting[userLanguage] || app.greeting.en
          : app.greeting;
    }

    return greeting;
  }, [app, loading, hydrating, chatModeResolving, currentLanguage, messages.length]);

  // Determine if input should be centered (only when showing example prompts)
  const shouldCenterInput = useMemo(() => {
    if (!app || loading || messages.length > 0) return false;

    return true;
  }, [app, loading, messages.length]);

  // Handle magic prompt with hooks
  const handleMagicPrompt = async () => {
    const enhancedPrompt = await magicPromptHandler.handleMagicPrompt(input, app, appId);
    if (enhancedPrompt) {
      setInput(enhancedPrompt);
    }
  };

  const handleUndoMagicPrompt = () => {
    const restoredInput = magicPromptHandler.handleUndoMagicPrompt();
    if (restoredInput !== null) {
      setInput(restoredInput);
    }
  };

  const handleInputChange = e => {
    setInput(e.target.value);
  };

  const handleStarterPromptClick = prompt => {
    if (prompt && typeof prompt === 'object') {
      if (prompt.message) {
        setInput(prompt.message);
      }
      if (prompt.variables) {
        setVariables(prev => ({ ...prev, ...prompt.variables }));
      }

      // If autoSend is enabled, automatically submit the form
      if (prompt.autoSend) {
        // Use setTimeout to ensure state updates are applied before submission
        setTimeout(() => {
          if (formRef.current) {
            formRef.current.requestSubmit();
          }
        }, 0);
      } else {
        // Only focus input if not auto-sending
        if (inputRef.current) {
          inputRef.current.focus();
        }
      }
    } else {
      setInput(prompt);
      if (inputRef.current) {
        inputRef.current.focus();
      }
    }
  };

  // Usage guide (issue #2838): the app's pre-written answer to "how do I use
  // this app?", shown without a model call. In the chat it is a question and
  // its answer, marked `isGreeting` so neither is sent to the model, stored or
  // exported. The start form and compare mode have no single transcript to
  // answer in, so there it opens in a viewer instead.
  const usageGuide = useUsageGuide(app, currentLanguage);
  const [usageGuideViewerOpen, setUsageGuideViewerOpen] = useState(false);
  const showUsageGuide = () => {
    if (!usageGuide.available) return;
    if (showStartForm || compareModeActive) {
      setUsageGuideViewerOpen(true);
      return;
    }
    const pairId = uuidv4();
    const answerId = `msg-${uuidv4()}`;
    const mark = { isGreeting: true, usageGuide: pairId };
    addUserMessage(usageGuide.question, mark);
    addAssistantMessage(answerId);
    updateAssistantMessage(answerId, usageGuide.content, false, {
      ...mark,
      outputFormat: 'markdown'
    });
  };
  const renderUsageGuideButton = variant =>
    usageGuide.available ? (
      <UsageGuideButton
        question={usageGuide.question}
        onClick={showUsageGuide}
        disabled={processing}
        variant={variant}
      />
    ) : null;

  const handleDeleteMessage = messageId => {
    // A guide exchange is not part of the conversation: removing it takes the
    // question and its answer, and leaves the turns after it alone.
    const pairId = messages.find(m => m.id === messageId)?.usageGuide;
    if (pairId) {
      messages.filter(m => m.usageGuide === pairId).forEach(m => removeMessage(m.id));
      return;
    }
    deleteMessage(messageId);
  };

  const handleEditMessage = (messageId, newContent) => {
    editMessage(messageId, newContent);
  };

  // Variables of a message being resent, when it had any. Kept in a ref as
  // well, so validation sees them before the state update has committed.
  const restoreVariables = restored => {
    if (!restored) return;
    setVariables(restored);
    pendingVariablesRef.current = restored;
  };

  const handleResendMessage = (messageId, editedContent) => {
    // A transcription turn's audio is not kept: there is nothing to resend,
    // and preparing a resend would already remove the transcript.
    if (isTranscriptionTurn(messages, messageId)) return;
    const resendData = prepareResend(messageId, editedContent);
    const filesToRestore = attachmentsOf(resendData);

    // Allow resending if there's content OR if the app allows empty content (for variable-only messages)
    if (!hasSomethingToSend(resendData.content, filesToRestore, app)) return;

    setInput(resendData.content || '');
    restoreVariables(resendData.variables);

    // The message's images, audio and documents become the selection again.
    fileUploadHandler.setSelectedFile(asSelection(filesToRestore));

    // Held from here on: resending the first exchange of a form-started chat
    // empties the transcript, and the composer has to stay to send it.
    setSentInChatId(chatId);

    // Submitting via a bare setTimeout races React's commit of the state set
    // above: when this whole resend is itself already running inside a
    // setTimeout (ChatMessage's edit-then-resend flow), the update can still
    // be pending when the timer fires, so handleSubmit reads the stale
    // (often empty) input and silently no-ops — the edited text is left
    // sitting in the box instead of being resent. Flagging it here and
    // submitting from the effect below guarantees the state is committed
    // first.
    setPendingAutoSubmit(true);
  };

  // Fires the actual resubmission only after the state handleResendMessage
  // just set (input/variables/files) has committed — see the comment there.
  useEffect(() => {
    if (!pendingAutoSubmit) return;
    setPendingAutoSubmit(false);
    formRef.current?.requestSubmit();
  }, [pendingAutoSubmit]);

  /**
   * Handle clarification response submission.
   * Formats the response and continues the conversation.
   *
   * @param {Object} response - The clarification response
   */
  const handleClarificationSubmit = useCallback(
    response => {
      const params = {
        modelId: selectedModel,
        style: selectedStyle,
        temperature,
        outputFormat: selectedOutputFormat,
        language: currentLanguage
      };
      submitClarificationResponse(response, params);
    },
    [
      submitClarificationResponse,
      selectedModel,
      selectedStyle,
      temperature,
      selectedOutputFormat,
      currentLanguage
    ]
  );

  /**
   * Handle clarification skip.
   * Creates a skip response and continues the conversation.
   *
   * @param {Object} response - The skip response
   */
  const handleClarificationSkip = useCallback(
    response => {
      const params = {
        modelId: selectedModel,
        style: selectedStyle,
        temperature,
        outputFormat: selectedOutputFormat,
        language: currentLanguage
      };
      submitClarificationResponse(response, params);
    },
    [
      submitClarificationResponse,
      selectedModel,
      selectedStyle,
      temperature,
      selectedOutputFormat,
      currentLanguage
    ]
  );

  // "Open in App" on a source: a new chat of the chosen app, with the source's
  // document attached (see the effect above). The one source action that is
  // this page's own — every other one runs in the sources panel — because it
  // needs the app router, which the embedded hosts do not have (issue #2453).
  const handleOpenSourceInApp = useCallback(
    (source, targetAppId) => {
      if (!targetAppId || !source?.ref?.id) return;
      const params = new URLSearchParams({
        prefill: source.title || '',
        documentId: source.ref.id,
        ...(source.ref.scope ? { searchProfile: source.ref.scope } : {}),
        source: source.provider
      });
      const targetPath = `/apps/${targetAppId}?${params.toString()}`;
      if (embedded) openInNewTab(targetPath);
      else navigate(targetPath);
    },
    [navigate, embedded, openInNewTab]
  );

  const clearChat = () => {
    if (
      window.confirm(
        t('pages.appChat.confirmClear', 'Are you sure you want to clear the entire chat history?')
      )
    ) {
      cancelGeneration('clear-chat');

      if (compareModeActive) {
        // Clear every compare panel (regenerates their chatIds internally)
        compareViewRef.current?.clearAll();
        setCompareFormSent(false);
      } else {
        // Clear regular chat
        clearMessages();
        resetConversationState();
        startNewChat();
        if (!embedded) clearConversationId(appId);
        conversationResumed.current = false;
      }

      // Reset the chat input to empty
      setInput('');

      // Clear any selected file and hide the uploader
      fileUploadHandler.clearSelectedFile();
      fileUploadHandler.hideUploader();

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
          variables: initialVars
        };
        if (!embedded) saveAppSettings(appId, settings);
      }
    }
  };

  // --- Audio to the selected model ---
  //
  // Audio always goes to the model selected in the chat:
  // - A transcription model answers with the transcript. Each uploaded file
  //   (or recording) is a turn of its own: its name as the question, the
  //   transcript streaming into the answer. The audio travels over the realtime
  //   socket, not the chat request, so in a stored chat the server stores the
  //   turn (services/chat/transcriptionTurn.js) and a chat model selected next
  //   answers follow-ups from it.
  // - A chat model that takes audio gets a recording attached, like an
  //   uploaded file, and sent with whatever is typed.
  // Dictation (the microphone) is separate: its text goes into the input field.

  // The recording in progress: `{ kind: 'transcribe', session, turn }` or
  // `{ kind: 'attach', recorder }`.
  const recordingRef = useRef(null);
  // True while a recording is being set up (microphone permission, socket) —
  // the window in which recordingRef is still null but a recording IS starting.
  const recorderStartingRef = useRef(false);
  // Set on unmount so async work resolving afterwards (a permission prompt
  // granted post-navigation) releases the microphone instead of capturing on.
  const disposedRef = useRef(false);
  const [isRecordingTranscription, setIsRecordingTranscription] = useState(false);
  const [recordElapsed, setRecordElapsed] = useState(0);

  const transcriptionErrorText = useCallback(
    err =>
      err?.code === 'too-long'
        ? t(
            'transcription.errors.tooLong',
            'This audio is {{duration}}s long, which exceeds the {{max}}s limit for transcription.',
            { duration: Math.round(err.duration), max: err.max }
          )
        : err?.code === 'mic'
          ? t(
              'transcription.errors.mic',
              'Could not access the microphone. Please grant permission and try again.'
            )
          : getTranscriptionErrorMessage(err, t),
    [t]
  );

  // A transcription that failed says why; a cancelled one does not.
  const reportTranscriptionFailure = useCallback(
    failure => {
      if (!failure || failure.code === 'aborted' || disposedRef.current) return;
      addSystemMessage(transcriptionErrorText(failure), true);
    },
    [addSystemMessage, transcriptionErrorText]
  );

  /**
   * Open a transcription turn on screen: the audio's name as the question and
   * an answer that grows with the transcript. `chat` goes in the session's
   * `start` frame, so the server stores the same turn — under the same
   * exchange id, which is what lets deleting it here fork the stored history.
   *
   * @param {string} label - What the question shows (the file name).
   * @param {{name: string, type?: string, bytes?: number}} attachment
   */
  const openTranscriptionTurn = useCallback(
    (label, attachment) => {
      const answerId = `msg-${uuidv4()}`;
      let shown = '';
      // Both halves are marked: the audio is not kept, so the question can be
      // neither edited nor resent (the stored turn carries the same mark).
      const mark = { transcription: true };
      return {
        chat: {
          chatId,
          appId,
          ephemeral: !serverBackedChat,
          clientMessageId: answerId,
          attachment
        },
        open() {
          addUserMessage(label, { ...mark, clientMessageId: answerId });
          addAssistantMessage(answerId);
          updateAssistantMessage(answerId, '', true, mark);
          setSentInChatId(chatId);
        },
        show(text) {
          shown = text;
          updateAssistantMessage(answerId, text, true, mark);
        },
        // Ends the answer. A failure keeps what was transcribed so far.
        finish(text, failure) {
          const noSpeech = failure ? '' : t('transcription.noSpeechInFile', '(no speech detected)');
          updateAssistantMessage(answerId, firstText(text, shown) || noSpeech, false, mark);
          reportTranscriptionFailure(failure);
        }
      };
    },
    [
      chatId,
      appId,
      serverBackedChat,
      addUserMessage,
      addAssistantMessage,
      updateAssistantMessage,
      reportTranscriptionFailure,
      t
    ]
  );

  const busyWithAudio = useCallback(() => {
    if (!transcribeAbortRef.current && !recordingRef.current) return false;
    addSystemMessage(
      t('transcription.errors.busy', 'A transcription is already running. Stop it first.'),
      true
    );
    return true;
  }, [addSystemMessage, t]);

  /** Transcribe one audio attachment into its turn; resolves with the transcript. */
  const transcribeFile = useCallback(
    async (file, turn, signal) => {
      // Audio extracted from a video keeps its WAV Blob: decoding that skips
      // re-parsing the base64 data URL.
      const audioBuffer = await decodeAudioFileToBuffer(
        file.blob instanceof Blob ? file.blob : file.base64
      );
      if (audioBuffer?.duration > MAX_TRANSCRIPTION_SECONDS) {
        throw Object.assign(new Error('too-long'), {
          code: 'too-long',
          duration: audioBuffer.duration,
          max: MAX_TRANSCRIPTION_SECONDS
        });
      }
      turn.show('');
      return transcribeAudioBuffer(audioBuffer, {
        modelId: transcriptionModel.id,
        signal,
        chat: turn.chat,
        onDelta: partial => turn.show(partial)
      });
    },
    [transcriptionModel]
  );

  /**
   * One file's turn: open it, transcribe the file into it, end it.
   * Resolves with the failure, or null.
   */
  const transcribeOneFile = useCallback(
    async (file, signal) => {
      const name = audioFileLabel(file, t('transcription.recording', 'Recording'));
      const turn = openTranscriptionTurn(name, {
        name,
        type: file.fileType || 'audio',
        bytes: file.fileSize
      });
      turn.open();
      try {
        const text = await transcribeFile(file, turn, signal);
        if (!disposedRef.current) turn.finish(text, null);
        return null;
      } catch (err) {
        if (!disposedRef.current) turn.finish('', err);
        return err;
      }
    },
    [openTranscriptionTurn, transcribeFile, t]
  );

  // The files in order, until one fails or the chat is left.
  const transcribeEach = useCallback(
    async (files, signal) => {
      for (const file of files) {
        if (disposedRef.current) return;
        if (await transcribeOneFile(file, signal)) return;
      }
    },
    [transcribeOneFile]
  );

  /**
   * Transcribe uploaded audio (or the audio of a video) with the selected
   * transcription model, one turn per file; stops at the first failure.
   *
   * @param {Object[]} files - The audio attachments.
   * @param {Object[]} [others] - The other attachments: they stay attached, for
   *   a chat model the user may switch to next.
   */
  const transcribeFiles = useCallback(
    async (files, others = []) => {
      if (busyWithAudio()) return;
      setInput('');
      fileUploadHandler.setSelectedFile(asSelection(others));
      fileUploadHandler.hideUploader();

      const abortController = new AbortController();
      transcribeAbortRef.current = abortController;
      setIsTranscribing(true);
      try {
        await transcribeEach(files, abortController.signal);
      } finally {
        transcribeAbortRef.current = null;
        setIsTranscribing(false);
      }
    },
    [busyWithAudio, fileUploadHandler, transcribeEach]
  );

  // A chat model that takes audio: attach the recording and send it with
  // whatever is typed, once React has committed the attachment.
  const sendRecordingAsAttachment = useCallback(
    async recorder => {
      let attachment = null;
      try {
        attachment = await recordedAttachment(
          recorder,
          `${t('transcription.recording', 'Recording')}.wav`
        );
      } catch (err) {
        reportTranscriptionFailure(err);
        return;
      }
      if (disposedRef.current || !attachment) return;
      fileUploadHandler.setSelectedFile(withAttachment(fileUploadHandler.selectedFile, attachment));
      setPendingAutoSubmit(true);
    },
    [fileUploadHandler, reportTranscriptionFailure, t]
  );

  // A transcription model: the microphone is off now; Stop cancels what is
  // left of the transcription.
  const finishRecordedTranscription = useCallback(
    async (session, turn) => {
      setIsTranscribing(true);
      transcribeAbortRef.current = { abort: () => session.cancel() };
      if (!session.text()) turn.show(t('transcription.transcribing', 'Transcribing…'));
      let text = '';
      let failure = null;
      try {
        text = await session.stop();
      } catch (err) {
        failure = err;
        text = err?.partialText || '';
      } finally {
        transcribeAbortRef.current = null;
        setIsTranscribing(false);
      }
      if (!disposedRef.current) turn.finish(text, failure);
    },
    [t]
  );

  const stopRecording = useCallback(async () => {
    const recording = recordingRef.current;
    if (!recording) return;
    recordingRef.current = null;
    setIsRecordingTranscription(false);
    if (recording.kind === 'attach') await sendRecordingAsAttachment(recording.recorder);
    else await finishRecordedTranscription(recording.session, recording.turn);
  }, [sendRecordingAsAttachment, finishRecordedTranscription]);

  // Record for a transcription model: its transcript grows in the answer.
  const startTranscribedRecording = useCallback(
    async onMaxDuration => {
      const label = t('transcription.recording', 'Recording');
      const turn = openTranscriptionTurn(label, { name: label, type: 'audio/wav' });
      const listening = t('transcription.listening', 'Listening…');
      let session = null;
      session = await startLiveTranscription({
        modelId: transcriptionModel.id,
        chat: turn.chat,
        onText: text => turn.show(text || listening),
        // The session failed while the user was still speaking.
        onError: err => {
          if (!session || recordingRef.current?.session !== session) return;
          recordingRef.current = null;
          setIsRecordingTranscription(false);
          turn.finish(err.partialText || '', err);
        },
        onTick: setRecordElapsed,
        maxDurationSeconds: MAX_TRANSCRIPTION_SECONDS,
        onMaxDuration
      });
      if (!disposedRef.current) {
        turn.open();
        turn.show(listening);
      }
      return { kind: 'transcribe', session, turn };
    },
    [transcriptionModel, openTranscriptionTurn, t]
  );

  // Record for a chat model that takes audio: the audio is kept in the tab.
  const startAttachedRecording = useCallback(async onMaxDuration => {
    const recorder = new AudioBufferRecorder({
      maxDurationSeconds: MAX_ATTACHED_RECORDING_SECONDS,
      onTick: setRecordElapsed,
      onMaxDuration
    });
    try {
      await recorder.start();
    } catch (err) {
      throw Object.assign(err instanceof Error ? err : new Error('mic'), { code: 'mic' });
    }
    return { kind: 'attach', recorder };
  }, []);

  const startRecording = useCallback(async () => {
    // Re-entrancy: a second click while the permission prompt is open would
    // start a second recorder and orphan the first (hot mic).
    if (recorderStartingRef.current) return;
    if (busyWithAudio()) return;
    const onMaxDuration = () => stopRecording();
    recorderStartingRef.current = true;
    // A transcription model gets the recording live; a chat model gets it attached.
    const begin = transcriptionModel ? startTranscribedRecording : startAttachedRecording;
    let recording = null;
    try {
      recording = await begin(onMaxDuration);
    } catch (err) {
      reportTranscriptionFailure(err);
      return;
    } finally {
      recorderStartingRef.current = false;
    }
    if (disposedRef.current) {
      // Unmounted while the permission prompt was open — release the mic.
      cancelRecording(recording);
      return;
    }
    recordingRef.current = recording;
    setRecordElapsed(0);
    setIsRecordingTranscription(true);
  }, [
    transcriptionModel,
    busyWithAudio,
    stopRecording,
    startTranscribedRecording,
    startAttachedRecording,
    reportTranscriptionFailure
  ]);

  const handleRecordTranscription = useCallback(() => {
    if (recordingRef.current) stopRecording();
    else startRecording();
  }, [startRecording, stopRecording]);

  // Cancel an in-flight transcription (wired to the Stop button).
  const cancelTranscription = useCallback(() => {
    if (transcribeAbortRef.current) transcribeAbortRef.current.abort();
  }, []);

  // Stop any active recording and abort an in-flight transcription if the
  // component unmounts, so no microphone stream or WebSocket is left open.
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      cancelRecording(recordingRef.current);
      recordingRef.current = null;
      if (transcribeAbortRef.current) {
        transcribeAbortRef.current.abort();
        transcribeAbortRef.current = null;
      }
    };
  }, []);

  /**
   * Send the composer's message — or, with `startFormMessage`, the rendered
   * start form, which already holds the composer's text as its {{content}}.
   *
   * @param {Event} e
   * @param {string|null} [startFormMessage]
   */
  const handleSubmit = async (e, startFormMessage = null) => {
    e.preventDefault();
    // An attachment is still being processed (e.g. the audio of a video is
    // extracted), in whichever composer it was added: the message would go
    // without it. Each composer holds back its own Send; this is the backstop
    // for the one that was not told.
    if (fileUploadHandler.isAttachmentProcessing) return;
    const typed = startFormMessage ?? input;

    // While recording, "send" means: finish the recording — sent to the
    // selected model, with anything typed when that is a chat model.
    if (recordingRef.current || recorderStartingRef.current) {
      stopRecording();
      return;
    }
    // Audio is still being transcribed.
    if (transcribeAbortRef.current) return;

    if (!typed.trim() && !fileUploadHandler.selectedFile && !app?.allowEmptyContent) {
      return;
    }

    // Use pending variables from ref if available (for resend operations),
    // otherwise use the state variables. This avoids race condition with async state updates.
    const currentVariables = pendingVariablesRef.current || variables;

    // A start form checks its own required fields; after it, the variables
    // are no longer on screen to be filled in.
    if (app?.variables && !startFormActive) {
      const missingRequiredVars = app.variables
        .filter(v => v.required)
        .filter(v => !currentVariables[v.name] || currentVariables[v.name].trim() === '');
      if (missingRequiredVars.length > 0) {
        const errorMessage =
          t('error.missingRequiredFields', 'Please fill in all required fields:') +
          ' ' +
          missingRequiredVars.map(v => getLocalizedContent(v.label, currentLanguage)).join(', ');
        addSystemMessage(errorMessage, true);
        if (window.innerWidth < 768 && !showParameters) {
          toggleParameters();
        }
        // Clear pending variables ref on validation failure
        pendingVariablesRef.current = null;
        return;
      }
    }

    if (compareModeActive ? compareIsProcessing : processing) return;

    // Audio goes to the selected model. A transcription model answers each
    // audio file with its transcript and nothing else: no text reaches it, from
    // the composer, an auto-send or a resend. Any other model has to take
    // audio itself.
    const selected = fileUploadHandler.selectedFile ? [fileUploadHandler.selectedFile].flat() : [];
    const audioFiles = selected.filter(f => f?.type === 'audio');
    if (!compareModeActive && transcriptionModel) {
      if (audioFiles.length > 0) {
        transcribeFiles(
          audioFiles,
          selected.filter(f => f?.type !== 'audio')
        );
      }
      return;
    }
    if (!compareModeActive && audioFiles.length > 0) {
      if (currentModelObject?.supportsAudio !== true) {
        addSystemMessage(
          t(
            'transcription.errors.modelTakesNoAudio',
            'The selected model cannot process audio. Select a model that can, or a transcription model, or remove the audio attachment.'
          ),
          true
        );
        return;
      }
    }

    let finalInput = typed.trim();
    let messageContent = finalInput;
    let messageData = {};

    if (fileUploadHandler.selectedFile) {
      // Handle multiple files
      if (Array.isArray(fileUploadHandler.selectedFile)) {
        const images = fileUploadHandler.selectedFile.filter(f => f.type === 'image');
        const audioFiles = fileUploadHandler.selectedFile.filter(f => f.type === 'audio');
        const documents = fileUploadHandler.selectedFile.filter(f => f.type === 'document');

        let contentParts = [finalInput];

        // Add image previews
        if (images.length > 0) {
          const imgPreviews = images
            .map(
              img =>
                `<img src="${img.base64}" alt="${t('common.uploadedImage', 'Uploaded image')}" style="max-width: 100%; max-height: 300px; margin-top: 8px;" />`
            )
            .join('\n');
          contentParts.push(imgPreviews);
        }

        // Add audio file indicators
        if (audioFiles.length > 0) {
          const audioIndicators = audioFiles
            .map(
              audio =>
                `<div style="display: inline-flex; align-items: center; background-color: #4b5563; border: 1px solid #d1d5db; border-radius: 6px; padding: 4px 8px; margin: 4px; font-size: 0.875em; color: #ffffff;">\n        <span style="margin-right: 4px;">🎵</span>\n        <span>${audio.fileName}</span>\n      </div>`
            )
            .join('');
          contentParts.push(audioIndicators);
        }

        // Add file indicators
        if (documents.length > 0) {
          const fileIndicators = documents
            .map(
              doc =>
                `<div style="display: inline-flex; align-items: center; background-color: #4b5563; border: 1px solid #d1d5db; border-radius: 6px; padding: 4px 8px; margin: 4px; font-size: 0.875em; color: #ffffff;">\n        <span style="margin-right: 4px;">📎</span>\n        <span>${doc.fileName}</span>\n      </div>`
            )
            .join('');
          contentParts.push(fileIndicators);
        }

        messageContent = contentParts.filter(Boolean).join('\n\n');
        messageData = {
          imageData: images.length > 0 ? images : undefined,
          audioData: audioFiles.length > 0 ? audioFiles : undefined,
          fileData: documents.length > 0 ? documents : undefined
        };
      } else {
        // Handle single file (legacy behavior)
        if (fileUploadHandler.selectedFile.type === 'image') {
          const imgPreview = `<img src="${fileUploadHandler.selectedFile.base64}" alt="${t('common.uploadedImage', 'Uploaded image')}" style="max-width: 100%; max-height: 300px; margin-top: 8px;" />`;
          messageContent = finalInput ? `${finalInput}\n\n${imgPreview}` : imgPreview;
          messageData = { imageData: fileUploadHandler.selectedFile };
        } else if (fileUploadHandler.selectedFile.type === 'audio') {
          const audioIndicator = `<div style="display: inline-flex; align-items: center; background-color: #4b5563; border: 1px solid #d1d5db; border-radius: 6px; padding: 4px 8px; margin-left: 8px; font-size: 0.875em; color: #ffffff;">\n        <span style="margin-right: 4px;">🎵</span>\n        <span>${fileUploadHandler.selectedFile.fileName}</span>\n      </div>`;
          messageContent = finalInput ? `${finalInput} ${audioIndicator}` : audioIndicator;
          messageData = { audioData: fileUploadHandler.selectedFile };
        } else {
          const fileIndicator = `<div style="display: inline-flex; align-items: center; background-color: #4b5563; border: 1px solid #d1d5db; border-radius: 6px; padding: 4px 8px; margin-left: 8px; font-size: 0.875em; color: #ffffff;">\n        <span style="margin-right: 4px;">📎</span>\n        <span>${fileUploadHandler.selectedFile.fileName}</span>\n      </div>`;
          messageContent = finalInput ? `${finalInput} ${fileIndicator}` : fileIndicator;
          messageData = { fileData: fileUploadHandler.selectedFile };
        }
      }
    }

    const params = {
      modelId: selectedModel,
      style: selectedStyle,
      temperature,
      outputFormat: selectedOutputFormat,
      language: currentLanguage,
      ...(thinkingEnabled !== null ? { thinkingEnabled } : {}),
      ...(thinkingLevel !== null ? { thinkingLevel } : {}),
      ...(thinkingThoughts !== null ? { thinkingThoughts } : {}),
      ...(effectiveEnabledTools !== null && effectiveEnabledTools !== undefined
        ? { enabledTools: effectiveEnabledTools }
        : {}),
      ...(app?.websearch?.enabled ? { websearchEnabled } : {}),
      ...(imageAspectRatio ? { imageAspectRatio } : {}),
      ...(imageQuality ? { imageQuality } : {}),
      ...(documentId ? { documentIds: [documentId] } : {})
    };

    debugLog('📤 Sending message with params:', params);

    // Validate variables: fall back to defaults if empty or whitespace-only
    const validatedVariables = {};
    if (app?.variables && app.variables.length > 0) {
      app.variables.forEach(varConfig => {
        const currentValue = currentVariables[varConfig.name];
        const isEmptyOrWhitespace =
          currentValue === undefined ||
          currentValue === null ||
          (typeof currentValue === 'string' && currentValue.trim() === '');

        if (isEmptyOrWhitespace) {
          // Use default value if current value is empty/whitespace
          const defaultValue =
            typeof varConfig.defaultValue === 'object'
              ? getLocalizedContent(varConfig.defaultValue, currentLanguage)
              : varConfig.defaultValue || '';
          validatedVariables[varConfig.name] = defaultValue;
        } else {
          // Use current value
          validatedVariables[varConfig.name] = currentValue;
        }
      });
    }

    // Which messages carry the app variables. Beside the chat they may change
    // between messages, so every message does. With a start form only the
    // form's message does, or a resend of it (which restored them): the server
    // keeps them for the rest of the chat.
    const carriesVariables =
      !startFormActive || startFormMessage !== null || pendingVariablesRef.current !== null;

    // Prepare the message structure for sending
    const messageStructure = {
      displayMessage: {
        content: messageContent,
        meta: {
          rawContent: typed,
          variables:
            carriesVariables && app?.variables?.length > 0 ? { ...validatedVariables } : undefined,
          ...messageData
        }
      },
      apiMessage: {
        content: typed,
        // A start form's message is its prompt, already rendered; the ones
        // after it go as typed.
        promptTemplate: startFormActive ? null : app?.prompt || null,
        variables: carriesVariables ? { ...validatedVariables } : undefined,
        imageData: (() => {
          // Handle image data: convert to object/array/null based on count
          const imageFiles = Array.isArray(fileUploadHandler.selectedFile)
            ? fileUploadHandler.selectedFile.filter(f => f.type === 'image')
            : fileUploadHandler.selectedFile?.type === 'image'
              ? [fileUploadHandler.selectedFile]
              : [];
          // Return single object for 1 file, array for multiple, null for none
          return imageFiles.length === 1
            ? imageFiles[0]
            : imageFiles.length > 1
              ? imageFiles
              : null;
        })(),
        audioData: (() => {
          // Handle audio data: convert to object/array/null based on count
          const audioFiles = Array.isArray(fileUploadHandler.selectedFile)
            ? fileUploadHandler.selectedFile.filter(f => f.type === 'audio')
            : fileUploadHandler.selectedFile?.type === 'audio'
              ? [fileUploadHandler.selectedFile]
              : [];
          // Return single object for 1 file, array for multiple, null for none
          return audioFiles.length === 1
            ? audioFiles[0]
            : audioFiles.length > 1
              ? audioFiles
              : null;
        })(),
        fileData: (() => {
          // Handle file data: convert to object/array/null based on count
          const documentFiles = Array.isArray(fileUploadHandler.selectedFile)
            ? fileUploadHandler.selectedFile.filter(f => f.type === 'document')
            : fileUploadHandler.selectedFile?.type === 'document'
              ? [fileUploadHandler.selectedFile]
              : [];
          // Return single object for 1 file, array for multiple, null for none
          return documentFiles.length === 1
            ? documentFiles[0]
            : documentFiles.length > 1
              ? documentFiles
              : null;
        })()
      },
      params,
      sendChatHistory,
      messageMetadata: {
        customResponseRenderer: app?.customResponseRenderer,
        outputFormat: selectedOutputFormat
      }
    };

    // If compare mode is active, broadcast to every panel; otherwise send through the regular chat
    if (compareModeActive) {
      compareViewRef.current?.sendMessage(messageStructure);
      if (startFormMessage !== null) setCompareFormSent(true);
    } else {
      sendChatMessage(messageStructure);
      setSentInChatId(chatId);
    }

    setInput('');
    magicPromptHandler.resetMagicPrompt();
    fileUploadHandler.clearSelectedFile();
    fileUploadHandler.hideUploader();
    // Clear pending variables ref after successful submission
    pendingVariablesRef.current = null;
  };

  // The first message of a form-started chat: the app's prompt, rendered with
  // the form's answers and, as {{content}}, text prefilled from the URL.
  const startFormMessage = showStartForm
    ? renderStartFormPrompt(
        app,
        resolveVariableValues(app, variables, currentLanguage),
        currentLanguage,
        input
      )
    : '';
  const handleStartFormSubmit = e => handleSubmit(e, startFormMessage);

  // Function to reload the current app
  const clearAppCache = useCallback(() => {
    // Client-side caching for apps was removed; simply reload
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
      }
    }
    setShowParameters(!showParameters);
  };

  const handleParametersOk = () => {
    // Apply temp variables to actual variables
    setVariables({ ...tempVariables });
    setShowParameters(false);
  };

  const handleParametersCancel = () => {
    // Discard changes and close modal
    setTempVariables({});
    setShowParameters(false);
  };

  const handleTempVariableChange = newVariables => {
    setTempVariables(newVariables);
  };

  // Memoize localizedVariables calculation to prevent unnecessary work on every render
  const localizedVariables = useMemo(
    () => localizeVariables(app?.variables, currentLanguage),
    [app?.variables, currentLanguage]
  );

  // Initialize temp variables when variables change
  useEffect(() => {
    if (!showParameters) {
      setTempVariables({ ...variables });
    }
  }, [variables, showParameters]);

  // Helper function to render the appropriate chat input component
  const renderChatInput = () => {
    const currentModel = models.find(m => m.id === selectedModel);

    // In compare mode, processing/cancel must reflect every panel — not the regular chat.
    // A running transcription also counts as "processing" so the Send button
    // becomes a Stop button that cancels it.
    const effectiveProcessing =
      (compareModeActive ? compareIsProcessing : processing) || isTranscribing;
    const effectiveCancel = isTranscribing
      ? cancelTranscription
      : compareModeActive
        ? () => compareViewRef.current?.cancelAll()
        : cancelGeneration;

    const commonProps = {
      app,
      value: input,
      onChange: handleInputChange,
      onSubmit: handleSubmit,
      isProcessing: effectiveProcessing,
      onCancel: effectiveCancel,
      // Dictation into the input field — nothing to type into while a
      // transcription model is selected.
      onVoiceInput:
        !transcriptionModel &&
        (app?.inputMode?.microphone?.enabled ?? app?.microphone?.enabled) !== false
          ? handleVoiceInput
          : undefined,
      onVoiceCommand:
        !transcriptionModel &&
        (app?.inputMode?.microphone?.enabled ?? app?.microphone?.enabled) !== false
          ? handleVoiceCommand
          : undefined,
      audioOnly: !compareModeActive && Boolean(transcriptionModel),
      // Record (separate from the dictation mic above): the recording goes to
      // the selected model, so only to one that takes audio.
      transcriptionRecordEnabled:
        !compareModeActive && (Boolean(transcriptionModel) || currentModel?.supportsAudio === true),
      // Not while a transcription finishes or an answer streams — except to
      // stop the recording that is running.
      onRecordTranscription:
        isTranscribing || (processing && !isRecordingTranscription)
          ? undefined
          : handleRecordTranscription,
      isRecordingTranscription,
      recordTranscriptionElapsed: recordElapsed,
      onFileSelect: fileUploadHandler.handleFileSelect,
      // The phone and the desktop layout each mount a composer, hidden by CSS
      // only: all of them have to know that an attachment is being processed
      isAttachmentProcessing: fileUploadHandler.isAttachmentProcessing,
      onAttachmentProcessingChange: fileUploadHandler.setAttachmentProcessing,
      uploadConfig: fileUploadHandler.createUploadConfig(app, currentModel),
      // While recording, Send stops the recording and sends it — with or
      // without anything typed.
      allowEmptySubmit:
        app?.allowEmptyContent ||
        fileUploadHandler.selectedFile !== null ||
        isRecordingTranscription,
      inputRef,
      formRef,
      selectedFile: fileUploadHandler.selectedFile,
      showUploader: fileUploadHandler.showUploader,
      onToggleUploader: fileUploadHandler.toggleUploader,
      magicPromptEnabled: featureFlags.isAppFeatureEnabled(app, 'magicPrompt.enabled', false),
      onMagicPrompt: handleMagicPrompt,
      showUndoMagicPrompt: magicPromptHandler.showUndoMagicPrompt,
      onUndoMagicPrompt: handleUndoMagicPrompt,
      magicPromptLoading: magicPromptHandler.magicLoading,
      enabledTools: effectiveEnabledTools,
      onEnabledToolsChange: toolsFeatureEnabled ? setEnabledTools : undefined,
      websearchEnabled,
      onWebsearchEnabledChange: app?.websearch?.enabled ? setWebsearchEnabled : undefined,
      // Ephemeral chat toggle (rendered next to the send button)
      ephemeral,
      onEphemeralChange: setEphemeral,
      // Image generation props
      model: currentModel,
      imageAspectRatio,
      imageQuality,
      onImageAspectRatioChange: setImageAspectRatio,
      onImageQualityChange: setImageQuality,
      // Skills in the `/` picker: a picked skill goes into the text as
      // `/<skill-name> ` and the server activates it from the message.
      skillsSlashEnabled:
        featureFlags.isEnabled('skills', false) &&
        ((Array.isArray(app?.skills) && app.skills.length > 0) || personalSkillsAvailable),
      // Clarification state
      clarificationPending,
      // Document token size warning
      fileTokenWarning,
      // Conversation so far + the history toggle, so the context-window
      // indicator reflects everything the next turn will send — not just the
      // pending message (issue #2283).
      messages,
      sendChatHistory
    };

    // Always use ChatInput (which now has the NextGen design with model selector)
    return (
      <ChatInput
        {...commonProps}
        models={models}
        selectedModel={selectedModel}
        onModelChange={setSelectedModel}
        currentLanguage={currentLanguage}
        showModelSelector={!compareModeActive && modelSelectionAllowed}
        // AI disclaimer shares the tight line below the input with the
        // ephemeral toggle; shown after the first submitted message.
        disclaimer={messages.length > 0 ? <AIDisclaimerBanner /> : null}
        // Once the start screen with its centered guide button is gone, the
        // guide stays one click away next to the input.
        leadingAction={
          messages.length > 0 || compareModeActive ? renderUsageGuideButton('inline') : null
        }
      />
    );
  };

  // The start form, for a new chat — or, below the compare panels' model
  // pickers, for a new comparison, which it is then sent to as a whole.
  const renderStartForm = () => {
    // A chat of unknown mode shows nothing, and a stored one its transcript
    // first — see renderStartupState. Compare panels never load anything.
    if (!compareModeActive && chatModeResolving) return null;
    if (!compareModeActive && hydrating) {
      return <LoadingSpinner message={t('pages.appChat.loadingChat', 'Loading chat...')} />;
    }
    return (
      <div className="min-h-full flex items-center justify-center p-4">
        <div className="w-full max-w-2xl">
          <ChatStartForm
            app={app}
            localizedVariables={localizedVariables}
            variables={variables}
            onVariablesChange={setVariables}
            message={input}
            onMessageChange={setInput}
            uploadConfig={fileUploadHandler.createUploadConfig(
              app,
              models.find(m => m.id === selectedModel)
            )}
            selectedFile={fileUploadHandler.selectedFile}
            onFileSelect={fileUploadHandler.handleFileSelect}
            isAttachmentProcessing={fileUploadHandler.isAttachmentProcessing}
            onAttachmentProcessingChange={fileUploadHandler.setAttachmentProcessing}
            onSubmit={handleStartFormSubmit}
            canSubmit={
              startFormMessage.trim() !== '' ||
              fileUploadHandler.selectedFile !== null ||
              app?.allowEmptyContent === true
            }
            isProcessing={(compareModeActive ? compareIsProcessing : processing) || isTranscribing}
            welcomeMessage={welcomeMessage}
            errorMessage={
              messages.filter(m => m.role === 'system' && m.error).at(-1)?.content || null
            }
            // The first message picks its model here, as the composer would;
            // a comparison has a picker per panel instead.
            models={compareModeActive ? null : models}
            selectedModel={selectedModel}
            onModelChange={setSelectedModel}
            showModelSelector={modelSelectionAllowed}
            currentLanguage={currentLanguage}
          />
          {usageGuide.available && (
            <div className="flex justify-center mt-4">{renderUsageGuideButton('hint')}</div>
          )}
        </div>
      </div>
    );
  };

  if (loading) {
    return <LoadingSpinner message={t('app.loading')} />;
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-screen">
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded-lg max-w-md">
          <p className="font-bold">{t('pages.appChat.errorTitle', 'Error')}</p>
          <p>{error}</p>
          <button
            onClick={clearAppCache}
            className="mt-3 bg-red-500 hover:bg-red-600 text-white font-bold py-2 px-4 rounded-sm"
          >
            {t('pages.appChat.clearCache', 'Clear Cache & Reload')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 h-full max-h-full min-h-0 overflow-hidden px-4 md:px-6 pt-2 sm:pt-4 pb-2">
      {/* Shared App Header */}
      <SharedAppHeader
        app={app}
        appId={appId}
        chatId={chatId}
        mode="chat"
        messages={messages}
        variables={variables}
        onClearChat={clearChat}
        currentLanguage={currentLanguage}
        models={models}
        styles={styles}
        selectedModel={selectedModel}
        selectedStyle={selectedStyle}
        selectedOutputFormat={selectedOutputFormat}
        sendChatHistory={sendChatHistory}
        temperature={temperature}
        thinkingEnabled={thinkingEnabled}
        thinkingLevel={thinkingLevel}
        thinkingThoughts={thinkingThoughts}
        enabledTools={effectiveEnabledTools}
        imageAspectRatio={imageAspectRatio}
        imageQuality={imageQuality}
        onModelChange={setSelectedModel}
        onStyleChange={setSelectedStyle}
        onOutputFormatChange={setSelectedOutputFormat}
        onSendChatHistoryChange={setSendChatHistory}
        onTemperatureChange={setTemperature}
        onThinkingEnabledChange={setThinkingEnabled}
        onThinkingLevelChange={setThinkingLevel}
        onThinkingThoughtsChange={setThinkingThoughts}
        onEnabledToolsChange={setEnabledTools}
        onImageAspectRatioChange={setImageAspectRatio}
        onImageQualityChange={setImageQuality}
        showConfig={showConfig}
        onToggleConfig={toggleConfig}
        onToggleParameters={toggleParameters}
        showParameters={showParameters}
        hideParametersButton={!showVariablesPanel}
        onShare={() => setShowShare(true)}
        showShareButton={shareEnabled || chatShareReady}
        conversationTitle={conversationTitle}
        showCompareModeToggle={compareModeFeatureEnabled && chatModels.length >= 2}
        compareModeActive={compareModeActive}
        onCompareModeChange={changeCompareMode}
        compareModeDisabled={processing || compareIsProcessing}
        showBackButton={!embedded}
        showEditAppButton={!embedded}
        onOpenCanvas={embedded ? () => openInNewTab(`/apps/${appId}/canvas`) : undefined}
      />

      {chatOrigin?.createdVia === 'scheduled-task' && (
        <ScheduledRunBanner origin={chatOrigin} onRunChanged={reloadScheduledRunChat} />
      )}

      {showVariablesPanel && showParameters && (
        <div
          role="presentation"
          className="md:hidden fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
          onClick={e => {
            // Close modal when clicking backdrop
            if (e.target === e.currentTarget) {
              handleParametersCancel();
            }
          }}
        >
          <div className="w-full bg-white dark:bg-gray-800 rounded-lg max-h-[90vh] overflow-hidden flex flex-col shadow-xl">
            <div className="flex justify-between items-center p-4 border-b dark:border-gray-700 shrink-0">
              <h3 className="font-medium text-gray-900 dark:text-gray-100">
                {t('pages.appChat.inputParameters')}
              </h3>
              <button
                onClick={handleParametersCancel}
                className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 p-1"
              >
                <Icon name="close" size="lg" className="text-current" />
              </button>
            </div>
            <div className="p-4 overflow-y-auto flex-1">
              <InputVariables
                variables={tempVariables}
                setVariables={handleTempVariableChange}
                localizedVariables={localizedVariables}
              />
            </div>
            <div className="flex gap-3 p-4 border-t dark:border-gray-700 bg-gray-50 dark:bg-gray-900 shrink-0">
              <button
                onClick={handleParametersCancel}
                className="flex-1 px-4 py-2 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 font-medium"
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                onClick={handleParametersOk}
                className="flex-1 px-4 py-2 text-white bg-blue-600 rounded-lg hover:bg-blue-700 font-medium"
              >
                {t('common.ok', 'OK')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Embedded, the chat sits in a panel far narrower than the viewport its
          breakpoints measure, so the input variables stack above it instead of
          taking a side column. */}
      <div
        className={`flex flex-col flex-1 gap-4 overflow-hidden mx-auto w-full ${embedded ? '' : 'md:flex-row'}`}
      >
        <div
          className={`flex flex-col max-w-6xl mx-auto w-full ${embedded ? 'flex-1 min-h-0' : 'h-full'}`}
        >
          {compareModeActive ? (
            /* Compare Mode View */
            <>
              <div className="flex-1 min-h-0 overflow-hidden">
                <CompareModeView
                  ref={compareViewRef}
                  app={app}
                  appId={appId}
                  models={chatModels}
                  currentLanguage={currentLanguage}
                  outputFormat={selectedOutputFormat}
                  sendChatHistory={sendChatHistory}
                  onPanelProcessingChange={handlePanelProcessingChange}
                  onMessageComplete={handleMessageComplete}
                  onOpenInCanvas={handleOpenInCanvas}
                  canvasEnabled={app?.features?.canvas === true}
                  requiredIntegrations={requiredIntegrations}
                  onConnectIntegration={connectIntegration}
                  onClarificationSubmit={handleClarificationSubmit}
                  onClarificationSkip={handleClarificationSkip}
                  onOpenSourceInApp={handleOpenSourceInApp}
                  linkPath={appPagePath}
                  ephemeral={ephemeral}
                  startForm={showStartForm ? renderStartForm() : null}
                />
              </div>
              {!showStartForm && (
                <div className="shrink-0 px-4 pt-2">
                  <div className="w-full max-w-4xl mx-auto">{renderChatInput()}</div>
                </div>
              )}
            </>
          ) : showStartForm ? (
            /* Start form, in place of the transcript and the composer */
            <div className="flex-1 min-h-0 overflow-y-auto">{renderStartForm()}</div>
          ) : shouldCenterInput ? (
            /* Centered layout for example prompts */
            <>
              {/* Mobile layout: content centers, input at bottom */}
              <div className="flex flex-col h-full md:hidden">
                <div className="flex-1 overflow-hidden flex flex-col">
                  {messages.length > 0 ? (
                    <div className="w-full h-full overflow-y-auto bg-gray-50 dark:bg-gray-800/50 rounded-lg flex flex-col">
                      <ChatMessageList
                        scheduleEnabledTools={effectiveEnabledTools}
                        messages={messages}
                        mcpAppHost={mcpAppHost}
                        outputFormat={selectedOutputFormat}
                        onDelete={handleDeleteMessage}
                        onEdit={handleEditMessage}
                        onResend={handleResendMessage}
                        editable={true}
                        appId={appId}
                        chatId={chatId}
                        modelId={selectedModel}
                        imagesPersisted={serverBackedChat}
                        onOpenInCanvas={handleOpenInCanvas}
                        onSaveAsPrompt={handleSaveAsPrompt}
                        onSaveAsSkill={handleSaveAsSkill}
                        canvasEnabled={app?.features?.canvas === true}
                        requiredIntegrations={requiredIntegrations}
                        onConnectIntegration={connectIntegration}
                        app={app}
                        models={models}
                        onClarificationSubmit={handleClarificationSubmit}
                        onClarificationSkip={handleClarificationSkip}
                        onOpenSourceInApp={handleOpenSourceInApp}
                        linkPath={appPagePath}
                      />
                    </div>
                  ) : (
                    <div className="w-full h-full overflow-y-auto">
                      <div className="min-h-full flex items-center justify-center p-4">
                        <div className="w-full max-w-4xl">
                          {renderStartupState(
                            app,
                            welcomeMessage,
                            handleStarterPromptClick,
                            hydrating,
                            chatModeResolving,
                            t,
                            renderUsageGuideButton('hint')
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                <div className="shrink-0 px-4 pt-2">
                  <div className="w-full max-w-4xl mx-auto">{renderChatInput()}</div>
                </div>
              </div>

              {/* Desktop layout: everything centered together */}
              <div className="hidden md:flex md:flex-col md:h-full md:items-center md:justify-center">
                <div className="w-full max-w-4xl">
                  {messages.length > 0 ? (
                    <div className="mb-8">
                      <ChatMessageList
                        scheduleEnabledTools={effectiveEnabledTools}
                        messages={messages}
                        mcpAppHost={mcpAppHost}
                        outputFormat={selectedOutputFormat}
                        onDelete={handleDeleteMessage}
                        onEdit={handleEditMessage}
                        onResend={handleResendMessage}
                        editable={true}
                        appId={appId}
                        chatId={chatId}
                        modelId={selectedModel}
                        imagesPersisted={serverBackedChat}
                        onOpenInCanvas={handleOpenInCanvas}
                        onSaveAsPrompt={handleSaveAsPrompt}
                        onSaveAsSkill={handleSaveAsSkill}
                        canvasEnabled={app?.features?.canvas === true}
                        requiredIntegrations={requiredIntegrations}
                        onConnectIntegration={connectIntegration}
                        app={app}
                        models={models}
                        onClarificationSubmit={handleClarificationSubmit}
                        onClarificationSkip={handleClarificationSkip}
                        onOpenSourceInApp={handleOpenSourceInApp}
                        linkPath={appPagePath}
                      />
                    </div>
                  ) : (
                    <div className="mb-8">
                      {renderStartupState(
                        app,
                        welcomeMessage,
                        handleStarterPromptClick,
                        hydrating,
                        chatModeResolving,
                        t,
                        renderUsageGuideButton('hint')
                      )}
                    </div>
                  )}
                  <div>{renderChatInput()}</div>
                </div>
              </div>
            </>
          ) : (
            /* Standard layout for normal chat and starter prompts */
            <>
              {/* Mobile layout: content scrollable, input at bottom */}
              <div className="flex flex-col h-full md:hidden">
                <div className="flex-1 overflow-hidden flex flex-col">
                  <ChatMessageList
                    scheduleEnabledTools={effectiveEnabledTools}
                    messages={messages}
                    mcpAppHost={mcpAppHost}
                    outputFormat={selectedOutputFormat}
                    onDelete={handleDeleteMessage}
                    onEdit={handleEditMessage}
                    onResend={handleResendMessage}
                    editable={true}
                    appId={appId}
                    chatId={chatId}
                    modelId={selectedModel}
                    imagesPersisted={serverBackedChat}
                    starterPrompts={app?.starterPrompts || []}
                    onSelectPrompt={handleStarterPromptClick}
                    welcomeMessage={welcomeMessage}
                    showCenteredInput={shouldCenterInput}
                    onOpenInCanvas={handleOpenInCanvas}
                    onSaveAsPrompt={handleSaveAsPrompt}
                    onSaveAsSkill={handleSaveAsSkill}
                    canvasEnabled={app?.features?.canvas === true}
                    requiredIntegrations={requiredIntegrations}
                    onConnectIntegration={connectIntegration}
                    app={app}
                    models={models}
                    onClarificationSubmit={handleClarificationSubmit}
                    onClarificationSkip={handleClarificationSkip}
                    onOpenSourceInApp={handleOpenSourceInApp}
                    linkPath={appPagePath}
                  />
                </div>
                <div className="shrink-0 px-4 pt-2">{renderChatInput()}</div>
              </div>

              {/* Desktop layout: normal flex column */}
              <div className="hidden md:flex md:flex-col md:h-full">
                <ChatMessageList
                  scheduleEnabledTools={effectiveEnabledTools}
                  messages={messages}
                  mcpAppHost={mcpAppHost}
                  outputFormat={selectedOutputFormat}
                  onDelete={handleDeleteMessage}
                  onEdit={handleEditMessage}
                  onResend={handleResendMessage}
                  editable={true}
                  appId={appId}
                  chatId={chatId}
                  modelId={selectedModel}
                  imagesPersisted={serverBackedChat}
                  starterPrompts={app?.starterPrompts || []}
                  onSelectPrompt={handleStarterPromptClick}
                  welcomeMessage={welcomeMessage}
                  showCenteredInput={shouldCenterInput}
                  onOpenInCanvas={handleOpenInCanvas}
                  onSaveAsPrompt={handleSaveAsPrompt}
                  onSaveAsSkill={handleSaveAsSkill}
                  canvasEnabled={app?.features?.canvas === true}
                  requiredIntegrations={requiredIntegrations}
                  onConnectIntegration={connectIntegration}
                  app={app}
                  models={models}
                  onClarificationSubmit={handleClarificationSubmit}
                  onClarificationSkip={handleClarificationSkip}
                  onOpenSourceInApp={handleOpenSourceInApp}
                  linkPath={appPagePath}
                />

                {renderChatInput()}
              </div>
            </>
          )}
        </div>

        {showVariablesPanel && (
          <div
            className={`hidden md:block overflow-y-auto p-4 bg-gray-50 dark:bg-gray-800 rounded-lg shrink-0 ${embedded ? 'order-first max-h-60' : 'w-80 lg:w-96'}`}
          >
            <h3 className="font-medium mb-3 text-gray-900 dark:text-gray-100">
              {t('pages.appChat.inputParameters')}
            </h3>
            <InputVariables
              variables={variables}
              setVariables={setVariables}
              localizedVariables={localizedVariables}
            />
          </div>
        )}
      </div>
      {promptDraft && (
        <Suspense fallback={null}>
          <PromptEditorModal
            initial={promptDraft}
            onClose={() => setPromptDraft(null)}
            onSaved={() => {
              setPromptDraft(null);
              setPromptSavedNotice(true);
              setTimeout(() => setPromptSavedNotice(false), 3000);
            }}
          />
        </Suspense>
      )}
      {promptSavedNotice && (
        <div
          role="status"
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 rounded-md bg-gray-900 text-white text-sm px-4 py-2 shadow-lg"
        >
          {t('prompts.notices.savedToLibrary', 'Saved to your prompts')}
        </div>
      )}
      {skillDraft && (
        <Suspense fallback={null}>
          <SkillEditorModal
            initial={skillDraft}
            onClose={() => setSkillDraft(null)}
            onSaved={saved => {
              setSkillDraft(null);
              setSavedSkillName(saved?.name || skillDraft.name);
            }}
          />
        </Suspense>
      )}
      {savedSkillName && (
        <div
          role="status"
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 rounded-md bg-gray-900 text-white text-sm px-4 py-2 shadow-lg"
        >
          {t('skills.notices.savedFromChat', {
            defaultValue: 'Saved to your skills. Type /{{name}} in a chat to use it.',
            name: savedSkillName
          })}
        </div>
      )}
      {usageGuideViewerOpen && (
        <Suspense fallback={null}>
          <MarkdownViewer
            content={usageGuide.content}
            name={usageGuide.question}
            onClose={() => setUsageGuideViewerOpen(false)}
          />
        </Suspense>
      )}
      {showShare && (
        <ShareDialog
          isOpen={showShare}
          onClose={() => setShowShare(false)}
          appName={app?.name}
          chatShare={chatShareOffered ? { chatId, ready: chatShareReady } : null}
          appLink={
            shareEnabled
              ? {
                  appId,
                  // A link to the app points at the app, never at one stored
                  // chat: the recipient does not own it and could only ever
                  // get a 404 from it.
                  path: embedded
                    ? appPagePath
                    : routeChatId
                      ? window.location.pathname.replace(/\/c\/[^/]+$/, '')
                      : window.location.pathname,
                  params: {
                    model: selectedModel,
                    style: selectedStyle,
                    outfmt: selectedOutputFormat,
                    temp: temperature,
                    history: sendChatHistory,
                    prefill: prefillMessage,
                    ...Object.fromEntries(
                      Object.entries(variables).map(([k, v]) => [`var_${k}`, v])
                    )
                  }
                }
              : null
          }
        />
      )}
    </div>
  );
}

export default AppChat;
