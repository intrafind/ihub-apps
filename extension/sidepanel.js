/**
 * Side panel UI — vanilla JS, no build step.
 *
 * Communicates with the background service worker via chrome.runtime messages
 * for one-shot calls and via a long-lived `chat-stream` port for streaming
 * chat responses. Tokens never live in this context.
 */

const $ = id => document.getElementById(id);

function send(message) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(message, resp =>
      resolve(resp || { ok: false, error: 'No response from background' })
    );
  });
}

const state = {
  uiLanguage: navigator.language?.split('-')[0] || 'en',
  apps: [],
  selectedAppId: null,
  starterPrompts: [],
  page: null,
  isStreaming: false,
  history: [], // [{role, content}]
  port: null
};

function localized(value, fallback = '') {
  if (!value) return fallback;
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return fallback;
  return value[state.uiLanguage] || value.en || Object.values(value)[0] || fallback;
}

function show(viewId) {
  for (const id of ['setup-view', 'signin-view', 'main-view']) {
    const el = $(id);
    if (!el) continue;
    el.hidden = id !== viewId;
  }
}

function appendMessage(role, text, opts = {}) {
  const el = document.createElement('div');
  el.className = 'message message-' + role + (opts.error ? ' message-error' : '');
  el.textContent = text;
  $('messages').appendChild(el);
  $('messages').scrollTop = $('messages').scrollHeight;
  return el;
}

async function refreshPageContext() {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs[0];
    if (!tab) return;
    state.page = { url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl };
    $('page-context').hidden = false;
    $('page-title-label').textContent = tab.title || tab.url || '';
    if (tab.favIconUrl) {
      $('page-favicon').innerHTML = `<img src="${tab.favIconUrl}" width="14" height="14" alt="" />`;
    } else {
      $('page-favicon').textContent = '🌐';
    }
  } catch {
    $('page-context').hidden = true;
  }
}

function appLabel(app) {
  return localized(app.name, app.id);
}

function appDescription(app) {
  return localized(app.description, '');
}

function findApp(id) {
  return state.apps.find(a => a.id === id) || null;
}

function renderAppSelect() {
  const sel = $('app-select');
  sel.innerHTML = '';
  for (const app of state.apps) {
    const opt = document.createElement('option');
    opt.value = app.id;
    opt.textContent = appLabel(app);
    opt.title = appDescription(app);
    sel.appendChild(opt);
  }
  if (state.apps.length > 0) {
    if (!state.selectedAppId || !findApp(state.selectedAppId)) {
      state.selectedAppId = state.apps[0].id;
    }
    sel.value = state.selectedAppId;
  }
}

function renderStarterPrompts() {
  const container = $('starter-prompts');
  container.innerHTML = '';
  const app = findApp(state.selectedAppId);
  let prompts = [];
  if (Array.isArray(app?.starterPrompts) && app.starterPrompts.length > 0) {
    prompts = app.starterPrompts;
  } else if (Array.isArray(state.starterPrompts) && state.starterPrompts.length > 0) {
    prompts = state.starterPrompts;
  }
  for (const p of prompts.slice(0, 8)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'starter-prompt';
    btn.textContent = localized(p.title, '');
    btn.addEventListener('click', () => {
      const message = localized(p.message, '');
      $('composer-input').value = message;
      submitMessage();
    });
    container.appendChild(btn);
  }
}

function buildPageFileData() {
  const page = state.page;
  if (!page) return null;
  // Match the shape used by the Outlook add-in's buildChatApiMessages so the
  // server-side chat pipeline ingests it identically.
  const slugify = s =>
    String(s || 'page')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'page';
  return [
    {
      source: 'web_page',
      fileName: `${slugify(page.title)}.md`,
      fileType: 'text/markdown',
      displayType: 'text/markdown',
      content: page.markdown
    }
  ];
}

async function ensurePageExtracted({ selectionOnly = false } = {}) {
  const resp = await send({ type: 'extract-page', selectionOnly });
  if (!resp.ok) throw new Error(resp.error || 'Failed to read page');
  const page = resp.page;
  const header = `# ${page.title || page.url}\n\nSource: ${page.url}\n\n`;
  state.page = {
    url: page.url,
    title: page.title,
    mode: page.mode,
    favIconUrl: state.page?.favIconUrl,
    markdown: header + (page.text || '')
  };
  return state.page;
}

function buildMessages({ userText }) {
  // Send only the new user turn — server applies the app system prompt + history
  // policy via the `sendChatHistory` flag, so we don't need to replay history.
  return [{ role: 'user', content: userText }];
}

function streamChatRequest({ appId, modelId, messages, fileData, onEvent, onDone, onError }) {
  const port = chrome.runtime.connect({ name: 'chat-stream' });
  state.port = port;
  port.onMessage.addListener(msg => {
    if (msg?.type === 'chat-event') onEvent(msg.event);
    else if (msg?.type === 'chat-done') onDone();
    else if (msg?.type === 'error') onError(new Error(msg.error || 'stream error'));
  });
  port.onDisconnect.addListener(() => {
    if (state.port === port) state.port = null;
  });
  port.postMessage({ type: 'start', appId, modelId, messages, fileData });
  return port;
}

async function submitMessage() {
  if (state.isStreaming) return;
  const text = $('composer-input').value.trim();
  if (!text) return;

  const includePage = $('include-page-toggle').checked;
  let fileData = null;
  if (includePage) {
    try {
      await ensurePageExtracted({ selectionOnly: false });
      fileData = buildPageFileData();
    } catch (err) {
      appendMessage('assistant', err.message || 'Could not read page', { error: true });
      return;
    }
  }

  appendMessage('user', text);
  $('composer-input').value = '';
  state.isStreaming = true;
  const assistantEl = appendMessage('assistant', '');
  let buffer = '';

  streamChatRequest({
    appId: state.selectedAppId,
    modelId: undefined,
    messages: buildMessages({ userText: text }),
    fileData,
    onEvent: ev => {
      // The /api/chat SSE pipeline emits events with various shapes — we
      // accept any payload that has a `content` or `text` property and
      // append it to the rolling buffer.
      const chunk = ev?.content ?? ev?.text ?? ev?.delta ?? '';
      if (typeof chunk === 'string') {
        buffer += chunk;
        assistantEl.textContent = buffer;
        $('messages').scrollTop = $('messages').scrollHeight;
      }
    },
    onDone: () => {
      state.isStreaming = false;
      state.history.push({ role: 'user', content: text });
      state.history.push({ role: 'assistant', content: buffer });
    },
    onError: err => {
      state.isStreaming = false;
      assistantEl.textContent = err.message || 'Request failed';
      assistantEl.classList.add('message-error');
    }
  });
}

async function loadApps() {
  const resp = await send({ type: 'list-apps' });
  if (!resp.ok) throw new Error(resp.error || 'Failed to load apps');
  // /api/apps returns either an array or { apps: [...] } depending on access mode
  const apps = Array.isArray(resp.apps) ? resp.apps : resp.apps?.apps || [];
  state.apps = apps;
  renderAppSelect();
  renderStarterPrompts();
}

async function loadRuntimeConfig() {
  const resp = await send({ type: 'get-runtime-config' });
  if (resp.ok && resp.config) {
    state.starterPrompts = resp.config.starterPrompts || [];
    const headerName = localized(resp.config.displayName, 'iHub Apps');
    if (headerName) $('header-title').textContent = headerName;
  }
}

async function bootstrap() {
  await refreshPageContext();
  // Refresh page context whenever the active tab changes.
  chrome.tabs.onActivated.addListener(refreshPageContext);
  chrome.tabs.onUpdated.addListener((_id, info) => {
    if (info.title || info.url || info.favIconUrl) refreshPageContext();
  });

  const baseResp = await send({ type: 'get-base-url' });
  if (!baseResp.ok || !baseResp.baseUrl) {
    show('setup-view');
    return;
  }

  await loadRuntimeConfig();

  const auth = await send({ type: 'auth-status' });
  if (!auth.signedIn) {
    $('signin-base-url').textContent = baseResp.baseUrl;
    show('signin-view');
    return;
  }

  try {
    await loadApps();
    show('main-view');
  } catch (err) {
    if (/Session expired/i.test(err.message || '')) {
      $('signin-base-url').textContent = baseResp.baseUrl;
      show('signin-view');
    } else {
      show('main-view');
      appendMessage('assistant', err.message || String(err), { error: true });
    }
  }
}

function bindUi() {
  $('open-options-btn').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('setup-open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

  $('signout-btn').addEventListener('click', async () => {
    await send({ type: 'sign-out' });
    bootstrap();
  });

  $('signin-btn').addEventListener('click', async () => {
    const errEl = $('signin-error');
    errEl.hidden = true;
    const resp = await send({ type: 'sign-in' });
    if (!resp.ok) {
      errEl.textContent = resp.error || 'Sign-in failed';
      errEl.hidden = false;
      return;
    }
    bootstrap();
  });

  $('app-select').addEventListener('change', e => {
    state.selectedAppId = e.target.value;
    renderStarterPrompts();
  });

  $('composer').addEventListener('submit', e => {
    e.preventDefault();
    submitMessage();
  });

  $('composer-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitMessage();
    }
  });

  $('send-page-btn').addEventListener('click', async () => {
    $('include-page-toggle').checked = true;
    if (!$('composer-input').value.trim()) {
      $('composer-input').value = 'Summarize this page.';
    }
    submitMessage();
  });

  $('send-selection-btn').addEventListener('click', async () => {
    try {
      await ensurePageExtracted({ selectionOnly: true });
      $('include-page-toggle').checked = true;
      if (!$('composer-input').value.trim()) {
        $('composer-input').value = 'Explain the selected text.';
      }
      submitMessage();
    } catch (err) {
      appendMessage('assistant', err.message || 'No selection found', { error: true });
    }
  });
}

bindUi();
bootstrap();
