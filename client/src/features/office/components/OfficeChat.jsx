import { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import ChatHeader from './chat/ChatHeader';
import ItemSelectorDialog from './apps-dialog';
import VariablesDialog, {
  buildInitialVariablesMap,
  getValidVariableDefinitions,
  mergeStarterPromptVariablesIntoValues,
  missingRequiredVariableNames
} from './variables-dialog';
import ChatMessage from './chat/ChatMessage';
import ChatInput from './chat/ChatInput';
import PromptButton from './chat/PromptButton';
import SettingsDialog from './settings-dialog';
import {
  createChatId,
  postChatMessage,
  extractChatReply,
  openChatSseResponse,
  readChatSseStream
} from '../api/officeChat';
import { useOfficeConfig } from '../contexts/OfficeConfigContext';
import { getAccessToken, authenticatedFetch } from '../api/officeAuth';
import { useOutlookMailContextReader } from '../hooks/useOutlookMailContext';
import {
  combineUserTextWithEmailBody,
  buildPromptTemplate,
  buildImageDataFromMailAttachments,
  buildFileDataFromMailAttachments,
  buildRichUserApiMessage,
  threadToApiMessages,
  createUserMessageId
} from '../utilities/buildChatApiMessages';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { officeLocale } from '../utilities/officeLocale';

const DEFAULT_PROMPTS = [
  {
    key: 'p1',
    label: 'Summarize this email',
    subtitle: '',
    message: 'Summarize this email',
    raw: null
  },
  {
    key: 'p2',
    label: 'Summarize and reply to this email',
    subtitle: '',
    message: 'Summarize and reply to this email',
    raw: null
  },
  {
    key: 'p3',
    label: 'What are the main takeaways from this email?',
    subtitle: '',
    message: 'What are the main takeaways from this email?',
    raw: null
  }
];

function buildChatVariablesPayload(appVariables, currentValues) {
  const defs = getValidVariableDefinitions(appVariables);
  if (!defs.length) return {};
  const out = {};
  for (const d of defs) {
    const raw = currentValues?.[d.name];
    out[d.name] = raw == null ? '' : String(raw);
  }
  return out;
}

function buildIhubChatBodyOptionsFromApp(app) {
  if (!app) return {};
  const o = {};
  if (app.tokenLimit != null && !Number.isNaN(Number(app.tokenLimit))) {
    o.tokenLimit = Number(app.tokenLimit);
  }
  const fmt = app.preferredOutputFormat;
  if (fmt != null && String(fmt).trim() !== '') {
    o.outputFormat = String(fmt);
  }
  const style = app.preferredStyle;
  if (style != null && String(style).trim() !== '') {
    o.style = String(style);
  }
  if (typeof app.preferredTemperature === 'number' && !Number.isNaN(app.preferredTemperature)) {
    o.temperature = app.preferredTemperature;
  }
  return o;
}

function localizeApp(app) {
  if (!app) return app;
  return {
    ...app,
    _localizedName: getLocalizedContent(app.name, officeLocale),
    _localizedPlaceholder: getLocalizedContent(app.messagePlaceholder, officeLocale),
    _localizedGreetingTitle: getLocalizedContent(app.greeting?.title, officeLocale),
    _localizedGreetingSubtitle: getLocalizedContent(app.greeting?.subtitle, officeLocale)
  };
}

function OfficeChat({ authData, selectedApp, setSelectedApp, onLogout }) {
  const config = useOfficeConfig();
  const navigate = useNavigate();
  const readMailContext = useOutlookMailContextReader();

  const app = localizeApp(selectedApp);

  const [chatKey, setChatKey] = useState(0);
  const [internalMessages, setInternalMessages] = useState([]);
  const [inputValue, setInputValue] = useState('');
  const [isWaitingForReply, setIsWaitingForReply] = useState(false);
  const [isSelectorOpen, setIsSelectorOpen] = useState(false);
  const [isVariablesOpen, setIsVariablesOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [appPromptVariables, setAppPromptVariables] = useState({});
  const [selectorItems, setSelectorItems] = useState([]);

  const chatIdRef = useRef(null);
  const streamAbortRef = useRef(null);
  const sseReaderRunningRef = useRef(false);
  const streamingAssistantIdRef = useRef(null);
  const sendGenerationRef = useRef(0);
  const selectedStarterPromptRef = useRef(null);
  const messagesScrollRef = useRef(null);
  const messageIdRef = useRef(0);

  useEffect(() => {
    const el = messagesScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [internalMessages]);

  // Reset chat when Outlook item changes (user switches emails)
  useEffect(() => {
    const handler = () => {
      streamAbortRef.current?.abort();
      streamAbortRef.current = null;
      sseReaderRunningRef.current = false;
      streamingAssistantIdRef.current = null;
      chatIdRef.current = null;
      selectedStarterPromptRef.current = null;
      messageIdRef.current = 0;
      sendGenerationRef.current = 0;
      setChatKey(prev => prev + 1);
      setInternalMessages([]);
      setInputValue('');
      setIsWaitingForReply(false);
    };
    document.addEventListener('ihub:itemchanged', handler);
    return () => document.removeEventListener('ihub:itemchanged', handler);
  }, []);

  useEffect(() => {
    if (!selectedApp?.id) {
      // eslint-disable-next-line @eslint-react/set-state-in-effect
      setAppPromptVariables({});
      // eslint-disable-next-line @eslint-react/set-state-in-effect
      setIsVariablesOpen(false);
      return;
    }
    const initial = buildInitialVariablesMap(selectedApp.variables);
    // eslint-disable-next-line @eslint-react/set-state-in-effect
    setAppPromptVariables(initial);
    const defs = getValidVariableDefinitions(selectedApp.variables);
    const missingRequired = defs.some(
      d => d.required === true && !String(initial[d.name] ?? '').trim()
    );
    // eslint-disable-next-line @eslint-react/set-state-in-effect
    setIsVariablesOpen(missingRequired);
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, [selectedApp?.id]);

  const resetChatSession = () => {
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    sseReaderRunningRef.current = false;
    streamingAssistantIdRef.current = null;
    chatIdRef.current = null;
    selectedStarterPromptRef.current = null;
    messageIdRef.current = 0;
    sendGenerationRef.current = 0;
  };

  const handleStopStream = useCallback(() => {
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    sseReaderRunningRef.current = false;
    setIsWaitingForReply(false);
  }, []);

  if (!authData) {
    // No auth — OfficeApp handles routing to login
    return null;
  }

  if (!selectedApp) {
    navigate('/select', { replace: true });
    return null;
  }

  const handleSendMessage = async content => {
    if (!content.trim() && !selectedApp?.allowEmptyContent) return;

    const appId = selectedApp?.id;
    const userId = ++messageIdRef.current;
    const assistantId = ++messageIdRef.current;
    const userMessage = { id: userId, role: 'user', content };

    if (!getAccessToken() || !appId) {
      const replyText = !getAccessToken()
        ? 'Not signed in. Please log in again.'
        : 'This app has no id; cannot send a message.';
      setInternalMessages(prev => [
        ...prev,
        userMessage,
        { id: assistantId, role: 'assistant', content: replyText }
      ]);
      setInputValue('');
      setIsWaitingForReply(false);
      return;
    }

    if (!chatIdRef.current) {
      chatIdRef.current = createChatId();
    }

    const myGeneration = ++sendGenerationRef.current;
    streamingAssistantIdRef.current = assistantId;
    setInternalMessages(prev => [
      ...prev,
      userMessage,
      { id: assistantId, role: 'assistant', content: '' }
    ]);
    setInputValue('');
    setIsWaitingForReply(true);

    streamAbortRef.current?.abort();
    streamAbortRef.current = new AbortController();
    const signal = streamAbortRef.current.signal;

    let mailCtx = { available: false, bodyText: null, attachments: [] };
    try {
      mailCtx = await readMailContext();
    } catch {}

    const nextThread = [...internalMessages, userMessage];

    const combinedContent = combineUserTextWithEmailBody(content, mailCtx.bodyText);
    const promptTemplate = buildPromptTemplate(selectedStarterPromptRef.current, selectedApp);
    const variablesPayload = buildChatVariablesPayload(selectedApp?.variables, appPromptVariables);
    const imageData = buildImageDataFromMailAttachments(mailCtx.attachments || []);
    const fileData = await buildFileDataFromMailAttachments(mailCtx.attachments || []);

    const richLastUserMessage = buildRichUserApiMessage({
      content: combinedContent,
      messageId: createUserMessageId(),
      promptTemplate,
      variables: variablesPayload,
      audioData: null,
      fileData,
      imageData
    });

    const shouldSendChatHistory = selectedApp?.sendChatHistory !== false;
    const apiMessages = shouldSendChatHistory
      ? threadToApiMessages(nextThread, richLastUserMessage)
      : [richLastUserMessage];

    const chatBodyOptions = buildIhubChatBodyOptionsFromApp(selectedApp);
    const chatBody = { messages: apiMessages, language: officeLocale, ...chatBodyOptions };

    const handleSseEvent = (eventName, data) => {
      if (myGeneration !== sendGenerationRef.current) return;
      if (eventName === 'chunk' && data?.content) {
        setInternalMessages(prev =>
          prev.map(m =>
            m.id === assistantId ? { ...m, content: (m.content || '') + data.content } : m
          )
        );
      } else if (eventName === 'done') {
        setIsWaitingForReply(false);
      } else if (eventName === 'error') {
        const msg = data?.message || 'Stream error';
        setInternalMessages(prev =>
          prev.map(m =>
            m.id === assistantId
              ? {
                  ...m,
                  content: (m.content || '') + (m.content ? '\n\n' : '') + msg
                }
              : m
          )
        );
        setIsWaitingForReply(false);
      }
    };

    try {
      let sseRes;
      try {
        sseRes = await openChatSseResponse(config, {
          appId,
          chatId: chatIdRef.current,
          signal
        });
      } catch {
        const json = await postChatMessage(config, {
          appId,
          chatId: chatIdRef.current,
          body: chatBody,
          signal
        });
        const replyText = extractChatReply(json);
        if (myGeneration !== sendGenerationRef.current) return;
        setInternalMessages(prev =>
          prev.map(m =>
            m.id === assistantId ? { ...m, content: replyText || '(Empty response)' } : m
          )
        );
        setIsWaitingForReply(false);
        return;
      }

      sseReaderRunningRef.current = true;
      void readChatSseStream(sseRes.body, handleSseEvent, signal, () => {
        sseReaderRunningRef.current = false;
        if (myGeneration !== sendGenerationRef.current) return;
        setIsWaitingForReply(still => (still ? false : still));
      }).catch(() => {
        if (signal.aborted) return;
        if (myGeneration !== sendGenerationRef.current) return;
        sseReaderRunningRef.current = false;
        setIsWaitingForReply(still => (still ? false : still));
      });

      await postChatMessage(config, {
        appId,
        chatId: chatIdRef.current,
        body: chatBody,
        signal
      });
    } catch (err) {
      if (err?.name === 'AbortError') {
        if (myGeneration === sendGenerationRef.current) {
          setIsWaitingForReply(false);
        }
        return;
      }
      const message =
        err && typeof err.message === 'string' ? err.message : 'Could not send message.';
      if (myGeneration !== sendGenerationRef.current) return;
      setInternalMessages(prev =>
        prev.map(m => (m.id === assistantId ? { ...m, content: m.content || message } : m))
      );
      setIsWaitingForReply(false);
    }
  };

  const handlePromptSelect = prompt => {
    if (prompt.raw != null) {
      selectedStarterPromptRef.current = prompt.raw;
    } else {
      selectedStarterPromptRef.current = { system: selectedApp?.system };
    }
    setInputValue(prompt.message);
    const pv = prompt.raw?.variables;
    if (pv && typeof pv === 'object' && selectedApp?.variables?.length) {
      setAppPromptVariables(prev =>
        mergeStarterPromptVariablesIntoValues(selectedApp.variables, pv, prev)
      );
    }
  };

  const starterPrompts = selectedApp?.starterPrompts?.length
    ? selectedApp.starterPrompts.map((p, idx) => ({
        key: p?.id ?? `${idx}`,
        label: getLocalizedContent(p?.title, officeLocale),
        subtitle: getLocalizedContent(p?.description, officeLocale),
        message: getLocalizedContent(p?.message, officeLocale),
        raw: p
      }))
    : DEFAULT_PROMPTS;

  const handleOpenSelector = () => {
    // Fetch fresh app list for in-chat switcher
    authenticatedFetch(config, `${config.baseUrl}/api/apps`)
      .then(res => (res.ok ? res.json() : []))
      .then(data => {
        if (Array.isArray(data)) setSelectorItems(data);
        setIsSelectorOpen(true);
      })
      .catch(() => setIsSelectorOpen(true));
  };

  const handleSelectApp = newApp => {
    resetChatSession();
    setSelectedApp(newApp);
    setIsSelectorOpen(false);
    setChatKey(prev => prev + 1);
    setInternalMessages([]);
    setInputValue('');
    setIsWaitingForReply(false);
  };

  const handleComposeNewChat = () => {
    resetChatSession();
    setChatKey(prev => prev + 1);
    setInternalMessages([]);
    setInputValue('');
    setIsWaitingForReply(false);
  };

  const greetingTitle = app?._localizedGreetingTitle;
  const greetingSubtitle = app?._localizedGreetingSubtitle;

  return (
    <div className="h-screen w-full flex flex-col p-0 bg-slate-50" key={chatKey}>
      <div className="flex-1 min-h-0 flex flex-col max-w-lg mx-auto w-full">
        <div className="flex flex-col h-full min-h-0 w-full overflow-hidden border border-[#e0e0e0] rounded-lg bg-white">
          <ChatHeader
            showCheckmark={false}
            selectedApp={{ name: app?._localizedName || 'Select app' }}
            onItemClick={handleOpenSelector}
            onWriteClick={handleComposeNewChat}
            onBackClick={() => navigate('/select', { replace: true })}
            menuItems={[
              ...(getValidVariableDefinitions(selectedApp?.variables).length > 0
                ? [
                    {
                      key: 'variables',
                      label: 'Show variables',
                      onClick: () => setIsVariablesOpen(true)
                    }
                  ]
                : []),
              { key: 'settings', label: 'Settings', onClick: () => setIsSettingsOpen(true) },
              { key: 'logout', label: 'Logout', onClick: onLogout }
            ]}
          />

          <div className="flex-1 flex flex-col min-h-0">
            <div ref={messagesScrollRef} className="flex-1 min-h-0 overflow-y-auto bg-slate-50">
              {internalMessages.length === 0 && (
                <div className="px-4 pt-6 pb-3 border-b border-slate-100 bg-slate-50/60">
                  <div className="flex flex-col items-center mb-4 text-center">
                    {greetingTitle || greetingSubtitle ? (
                      <>
                        {greetingTitle && (
                          <p className="text-base font-semibold text-slate-900">{greetingTitle}</p>
                        )}
                        {greetingSubtitle && (
                          <p className="mt-1 text-sm text-slate-600">{greetingSubtitle}</p>
                        )}
                      </>
                    ) : (
                      <div
                        className="w-16 h-16 flex items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 via-fuchsia-500 to-cyan-400 text-white font-bold text-2xl shadow-lg"
                        aria-hidden
                      >
                        AI
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col gap-2">
                    {starterPrompts.map(prompt => (
                      <PromptButton
                        key={prompt.key}
                        label={prompt.label}
                        subtitle={prompt.subtitle}
                        onClick={() => handlePromptSelect(prompt)}
                      />
                    ))}
                  </div>
                </div>
              )}

              <div className="p-3 space-y-2">
                {internalMessages.map((m, i) => (
                  <ChatMessage
                    key={m.id}
                    role={m.role}
                    content={m.content}
                    markdown={m.role === 'assistant'}
                    loading={
                      m.role === 'assistant' &&
                      isWaitingForReply &&
                      i === internalMessages.length - 1 &&
                      !String(m.content ?? '').trim()
                    }
                  />
                ))}
              </div>
            </div>

            <div className="border-t border-gray-200 bg-white">
              <ChatInput
                value={inputValue}
                onChange={setInputValue}
                onSubmit={handleSendMessage}
                placeholder={app?._localizedPlaceholder?.trim() || 'Type your message here . . .'}
                disabled={isWaitingForReply}
                isStreaming={isWaitingForReply}
                onStop={handleStopStream}
                allowEmptyContent={!!selectedApp?.allowEmptyContent}
              />
            </div>
          </div>
        </div>
      </div>

      <ItemSelectorDialog
        items={selectorItems}
        selectedApp={selectedApp}
        isOpen={isSelectorOpen}
        onSelect={handleSelectApp}
        onClose={() => setIsSelectorOpen(false)}
      />
      <VariablesDialog
        variables={selectedApp?.variables}
        currentValues={appPromptVariables}
        closeRequiresRequiredComplete
        isOpen={isVariablesOpen}
        onClose={() => setIsVariablesOpen(false)}
        onCancel={() => {
          setIsVariablesOpen(false);
          const defs = getValidVariableDefinitions(selectedApp?.variables);
          const missing = missingRequiredVariableNames(defs, appPromptVariables);
          if (missing.length > 0) navigate('/select', { replace: true });
        }}
        onSave={setAppPromptVariables}
      />
      <SettingsDialog
        user={authData?.user}
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
      />
    </div>
  );
}

export default OfficeChat;
