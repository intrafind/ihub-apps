/**
 * Auth Gate — Lightweight pre-auth application for ihub-apps.
 *
 * Runs as an IIFE before the React bundle loads. Checks authentication status
 * via /api/auth/status and either loads the main application or shows a login UI.
 *
 * Depends on:
 * - window.__BASE_PATH__ (set by inline script in index.html)
 * - __authGateI18n.t() (inlined by Vite plugin from i18n.js)
 * - #auth-gate-root (div in index.html)
 * - #auth-gate-data (JSON element injected by Vite plugin in production)
 *
 * Security: All dynamic text is sanitized via escapeHtml()/escapeAttr()
 * before DOM insertion. Only static template strings and escaped values
 * are used with innerHTML for rendering the login UI.
 */
(function authGate() {
  'use strict';

  var t = __authGateI18n.t;
  var API_BASE = (window.__BASE_PATH__ || '') + '/api';
  var ROOT_ID = 'auth-gate-root';
  var DATA_ID = 'auth-gate-data';
  var IS_DEV = !!window.__AUTH_GATE_DEV_MODE__;

  // --- State ---
  var authConfig = null;
  var gateUI = null;
  var currentError = null;
  var isSubmitting = false;
  var selectedAuthMethod = null; // 'local' | 'ldap' | null

  // --- Public API ---
  window.__authGate = {
    show: showGate,
    hide: hideGate,
    isVisible: function () {
      var root = document.getElementById(ROOT_ID);
      return root && !root.classList.contains('ag-hidden');
    }
  };

  // --- Session Expiry Listener ---
  window.addEventListener('showAuthGate', function (e) {
    var detail = (e && e.detail) || {};
    // Don't re-show if already visible (prevents race condition in dev mode
    // where React fires tokenExpired while gate is already showing login form)
    if (window.__authGate.isVisible()) return;
    showGate({ overlay: true, reason: detail.reason });
  });

  // --- Bootstrap ---
  checkAuthAndDecide();

  // =========================================================================
  // Core Flow
  // =========================================================================

  function checkAuthAndDecide() {
    var root = document.getElementById(ROOT_ID);
    if (!root) return loadApp(); // No gate root = skip gate

    // Show loading state
    renderLoading(root);

    // 1. Check URL params for callbacks
    var params = new URLSearchParams(window.location.search);

    // OIDC callback: ?token=...&provider=...
    if (params.get('token')) {
      handleOidcCallback(params);
      return;
    }

    // NTLM callback: ?ntlm=success
    if (params.get('ntlm') === 'success') {
      handleNtlmCallback();
      return;
    }

    // 2. Fetch auth status
    fetchAuthStatus()
      .then(function (data) {
        authConfig = data;
        gateUI = data.gateUI || null;

        // Already authenticated
        if (data.authenticated) {
          loadApp();
          return;
        }

        // Anonymous auth enabled — load app directly
        if (data.anonymousAuth && data.anonymousAuth.enabled) {
          loadApp();
          return;
        }

        // Proxy auth enabled — proxy handles auth upstream, load app
        if (data.authMethods && data.authMethods.proxy && data.authMethods.proxy.enabled) {
          loadApp();
          return;
        }

        // Auto-redirect to OIDC provider
        var isLogoutPage = params.get('logout') === 'true';
        if (data.autoRedirect && !isLogoutPage) {
          if (shouldAutoRedirect(data.autoRedirect.provider)) {
            markAutoRedirectAttempt(data.autoRedirect.provider);
            var returnUrl = window.location.href.split('?')[0];
            var sep = data.autoRedirect.url.indexOf('?') !== -1 ? '&' : '?';
            window.location.href =
              data.autoRedirect.url + sep + 'returnUrl=' + encodeURIComponent(returnUrl);
            return;
          }
        }

        // Show login UI
        renderAuthUI(root);
      })
      .catch(function (err) {
        renderError(root, err.message || t('serverError'));
      });
  }

  // =========================================================================
  // API
  // =========================================================================

  function fetchAuthStatus() {
    var headers = { Accept: 'application/json' };
    var token = getStoredToken();
    if (token) {
      headers['Authorization'] = 'Bearer ' + token;
    }

    return fetch(API_BASE + '/auth/status', {
      method: 'GET',
      credentials: 'include',
      headers: headers
    }).then(function (res) {
      if (!res.ok) throw new Error(t('serverError'));
      return res.json();
    });
  }

  function postLogin(endpoint, body) {
    return fetch(API_BASE + endpoint, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json();
    });
  }

  // =========================================================================
  // Callback Handlers
  // =========================================================================

  function handleOidcCallback(params) {
    var token = params.get('token');

    // Store token
    storeToken(token);

    // Clean URL
    cleanUrlParams(['token', 'provider']);

    // Verify authentication
    fetchAuthStatus()
      .then(function (data) {
        if (data.authenticated) {
          loadApp();
        } else {
          // Token was invalid
          removeToken();
          authConfig = data;
          var root = document.getElementById(ROOT_ID);
          renderAuthUI(root);
        }
      })
      .catch(function () {
        loadApp(); // Optimistic — let React handle it
      });
  }

  function handleNtlmCallback() {
    // Clean URL
    cleanUrlParams(['ntlm']);

    // Verify authentication
    fetchAuthStatus()
      .then(function (data) {
        if (data.authenticated) {
          loadApp();
        } else {
          authConfig = data;
          var root = document.getElementById(ROOT_ID);
          renderAuthUI(root);
        }
      })
      .catch(function () {
        loadApp();
      });
  }

  // =========================================================================
  // App Loading
  // =========================================================================

  function loadApp() {
    var root = document.getElementById(ROOT_ID);

    if (IS_DEV) {
      // In dev mode, just hide the gate — module scripts are already in HTML
      if (root) {
        root.classList.add('ag-fade-out');
        setTimeout(function () {
          root.classList.add('ag-hidden');
          root.textContent = '';
          // Show the React root
          var appRoot = document.getElementById('root');
          if (appRoot) appRoot.style.display = '';
          // Signal React to refresh auth state (e.g. after login via gate)
          window.dispatchEvent(new CustomEvent('authGateSuccess'));
        }, 200);
      }
      return;
    }

    // Production: inject Vite assets from the data element
    var dataEl = document.getElementById(DATA_ID);
    if (!dataEl) {
      // No data element = gate was not properly set up, just hide
      if (root) {
        root.classList.add('ag-hidden');
        root.textContent = '';
      }
      return;
    }

    var assets;
    try {
      assets = JSON.parse(dataEl.textContent);
    } catch (e) {
      console.error('Auth gate: failed to parse asset data', e);
      if (root) {
        root.classList.add('ag-hidden');
        root.textContent = '';
      }
      return;
    }

    // Inject stylesheets
    (assets.stylesheets || []).forEach(function (href) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      document.head.appendChild(link);
    });

    // Inject modulepreload hints
    (assets.preloads || []).forEach(function (href) {
      var link = document.createElement('link');
      link.rel = 'modulepreload';
      link.href = href;
      document.head.appendChild(link);
    });

    // Inject module scripts (entry points)
    (assets.scripts || []).forEach(function (src) {
      var script = document.createElement('script');
      script.type = 'module';
      script.src = src;
      document.body.appendChild(script);
    });

    // Fade out and hide the gate
    if (root) {
      root.classList.add('ag-fade-out');
      setTimeout(function () {
        root.classList.add('ag-hidden');
        root.textContent = '';
      }, 200);
    }
  }

  // =========================================================================
  // Gate Visibility
  // =========================================================================

  function showGate(options) {
    options = options || {};
    var root = document.getElementById(ROOT_ID);
    if (!root) return;

    root.classList.remove('ag-hidden', 'ag-fade-out');
    root.textContent = '';

    if (options.overlay) {
      root.classList.add('ag-overlay');
    }

    // Re-fetch auth status and show UI
    renderLoading(root);
    fetchAuthStatus()
      .then(function (data) {
        authConfig = data;
        gateUI = data.gateUI || null;
        if (data.authenticated) {
          hideGate();
          window.dispatchEvent(new CustomEvent('authGateSuccess'));
          return;
        }
        currentError = options.reason === 'tokenExpired' ? t('sessionExpired') : null;
        renderAuthUI(root);
      })
      .catch(function (err) {
        renderError(root, err.message || t('serverError'));
      });
  }

  function hideGate() {
    var root = document.getElementById(ROOT_ID);
    if (!root) return;
    root.classList.add('ag-fade-out');
    setTimeout(function () {
      root.classList.add('ag-hidden');
      root.classList.remove('ag-overlay');
      root.textContent = '';
    }, 200);
  }

  // =========================================================================
  // Rendering — uses safe DOM construction with escaped values
  // =========================================================================

  function renderLoading(root) {
    // Build loading UI via DOM API
    var card = createElement('div', 'ag-card');
    var wrap = createElement('div', 'ag-loading');
    wrap.appendChild(createElement('div', 'ag-loading-spinner'));
    var text = createElement('div', 'ag-loading-text');
    text.textContent = t('loading');
    wrap.appendChild(text);
    card.appendChild(wrap);
    root.textContent = '';
    root.appendChild(card);
  }

  function renderError(root, message) {
    var card = createElement('div', 'ag-card');
    card.appendChild(buildHeader());

    var errDiv = createElement('div', 'ag-error');
    errDiv.textContent = message;
    card.appendChild(errDiv);

    var retryBtn = createElement('button', 'ag-btn ag-btn-primary');
    retryBtn.textContent = t('retry');
    retryBtn.addEventListener('click', function () {
      checkAuthAndDecide();
    });
    card.appendChild(retryBtn);

    root.textContent = '';
    root.appendChild(card);
  }

  function buildHeader() {
    var appName = (gateUI && gateUI.appName) || 'iHub Apps';
    var logoUrl = gateUI && gateUI.logoUrl;

    var header = createElement('div', 'ag-header');

    // Logo — use configured logo or fall back to app icon
    var logoDiv = createElement('div', 'ag-logo');
    var img = document.createElement('img');
    img.src = logoUrl || (window.__BASE_PATH__ || '') + '/icons/apps-svg-logo.svg';
    img.alt = '';
    logoDiv.appendChild(img);
    header.appendChild(logoDiv);

    var h1 = document.createElement('h1');
    h1.className = 'ag-app-name';
    h1.textContent = appName;
    header.appendChild(h1);

    var sub = document.createElement('p');
    sub.className = 'ag-subtitle';
    sub.textContent = t('signIn');
    header.appendChild(sub);

    return header;
  }

  function renderAuthUI(root) {
    if (!authConfig || !authConfig.authMethods) {
      renderError(root, t('serverError'));
      return;
    }

    var methods = authConfig.authMethods;
    var hasOidc =
      methods.oidc &&
      methods.oidc.enabled &&
      methods.oidc.providers &&
      methods.oidc.providers.length > 0;
    var hasNtlm = methods.ntlm && methods.ntlm.enabled;
    var hasLocal = methods.local && methods.local.enabled;
    var hasLdap = methods.ldap && methods.ldap.enabled;
    var hasUsernamePassword = hasLocal || hasLdap;

    // Count auth method groups for separator logic
    var methodCount = (hasOidc ? 1 : 0) + (hasNtlm ? 1 : 0) + (hasUsernamePassword ? 1 : 0);

    var card = createElement('div', 'ag-card');
    card.appendChild(buildHeader());

    // Error message
    if (currentError) {
      var errDiv = createElement('div', 'ag-error');
      errDiv.textContent = currentError;
      card.appendChild(errDiv);
    }

    // OIDC Providers
    if (hasOidc) {
      methods.oidc.providers.forEach(function (provider) {
        var btn = createElement('button', 'ag-btn ag-btn-outline');
        var icon = createElement('span', 'ag-btn-icon');
        icon.textContent = getProviderIcon(provider.name);
        btn.appendChild(icon);
        btn.appendChild(document.createTextNode(provider.displayName || provider.name));
        btn.addEventListener('click', function () {
          handleOidcLogin(provider.name);
        });
        card.appendChild(btn);
      });

      if (methodCount > 1) {
        card.appendChild(buildDivider());
      }
    }

    // NTLM Button
    if (hasNtlm) {
      var ntlmBtn = createElement('button', 'ag-btn ag-btn-outline');
      var ntlmIcon = createElement('span', 'ag-btn-icon');
      ntlmIcon.textContent = '\uD83D\uDD12'; // lock icon
      ntlmBtn.appendChild(ntlmIcon);
      ntlmBtn.appendChild(document.createTextNode(t('windowsAuth')));
      if (methods.ntlm.domain) {
        var domainHint = createElement('span', 'ag-domain-hint');
        domainHint.textContent = '(' + methods.ntlm.domain + ')';
        ntlmBtn.appendChild(domainHint);
      }
      ntlmBtn.addEventListener('click', handleNtlmLogin);
      card.appendChild(ntlmBtn);

      if (hasUsernamePassword) {
        card.appendChild(buildDivider());
      }
    }

    // Username/Password Auth
    if (hasUsernamePassword) {
      if (hasLocal && hasLdap && !selectedAuthMethod) {
        // Method selection
        var localBtn = createElement('button', 'ag-btn ag-btn-outline');
        var localIcon = createElement('span', 'ag-btn-icon');
        localIcon.textContent = '\uD83D\uDD11'; // key icon
        localBtn.appendChild(localIcon);
        localBtn.appendChild(document.createTextNode(t('localAuth')));
        localBtn.addEventListener('click', function () {
          selectedAuthMethod = 'local';
          currentError = null;
          renderAuthUI(root);
        });
        card.appendChild(localBtn);

        var ldapBtn = createElement('button', 'ag-btn ag-btn-outline');
        var ldapIcon = createElement('span', 'ag-btn-icon');
        ldapIcon.textContent = '\uD83C\uDFE2'; // office icon
        ldapBtn.appendChild(ldapIcon);
        ldapBtn.appendChild(document.createTextNode(t('ldapAuth')));
        ldapBtn.addEventListener('click', function () {
          selectedAuthMethod = 'ldap';
          currentError = null;
          renderAuthUI(root);
        });
        card.appendChild(ldapBtn);
      } else {
        // Login form
        var authMethod = selectedAuthMethod || (hasLocal ? 'local' : 'ldap');

        // Back button
        if (selectedAuthMethod && hasLocal && hasLdap) {
          var backBtn = createElement('button', 'ag-btn-link');
          backBtn.textContent = '\u2190 ' + t('backToMethods');
          backBtn.addEventListener('click', function () {
            selectedAuthMethod = null;
            currentError = null;
            renderAuthUI(root);
          });
          card.appendChild(backBtn);
        }

        var form = document.createElement('form');
        form.id = 'ag-login-form';

        // LDAP provider dropdown
        if (authMethod === 'ldap' && methods.ldap.providers && methods.ldap.providers.length > 1) {
          var providerGroup = createElement('div', 'ag-form-group');
          var providerLabel = createElement('label', 'ag-label');
          providerLabel.textContent = t('ldapProvider');
          providerLabel.setAttribute('for', 'ag-provider');
          providerGroup.appendChild(providerLabel);

          var select = document.createElement('select');
          select.className = 'ag-select';
          select.id = 'ag-provider';
          select.name = 'provider';

          var defaultOpt = document.createElement('option');
          defaultOpt.value = '';
          defaultOpt.textContent = t('autoDetect');
          select.appendChild(defaultOpt);

          methods.ldap.providers.forEach(function (p) {
            var opt = document.createElement('option');
            opt.value = p.name;
            opt.textContent = p.displayName || p.name;
            select.appendChild(opt);
          });
          providerGroup.appendChild(select);
          form.appendChild(providerGroup);
        }

        // Username field
        var usernameGroup = createElement('div', 'ag-form-group');
        var usernameLabel = createElement('label', 'ag-label');
        usernameLabel.textContent = t('username');
        usernameLabel.setAttribute('for', 'ag-username');
        usernameGroup.appendChild(usernameLabel);

        var usernameInput = document.createElement('input');
        usernameInput.className = 'ag-input';
        usernameInput.type = 'text';
        usernameInput.id = 'ag-username';
        usernameInput.name = 'username';
        usernameInput.placeholder = t('usernamePlaceholder');
        usernameInput.required = true;
        usernameInput.autocomplete = 'username';
        usernameGroup.appendChild(usernameInput);
        form.appendChild(usernameGroup);

        // Password field
        var passwordGroup = createElement('div', 'ag-form-group');
        var passwordLabel = createElement('label', 'ag-label');
        passwordLabel.textContent = t('password');
        passwordLabel.setAttribute('for', 'ag-password');
        passwordGroup.appendChild(passwordLabel);

        var passwordInput = document.createElement('input');
        passwordInput.className = 'ag-input';
        passwordInput.type = 'password';
        passwordInput.id = 'ag-password';
        passwordInput.name = 'password';
        passwordInput.placeholder = t('passwordPlaceholder');
        passwordInput.required = true;
        passwordInput.autocomplete = 'current-password';
        passwordGroup.appendChild(passwordInput);
        form.appendChild(passwordGroup);

        // Submit button
        var submitBtn = createElement('button', 'ag-btn ag-btn-primary');
        submitBtn.type = 'submit';
        submitBtn.id = 'ag-submit-btn';
        submitBtn.textContent = t('signIn');
        form.appendChild(submitBtn);

        form.addEventListener('submit', function (e) {
          e.preventDefault();
          handleFormSubmit(root);
        });

        card.appendChild(form);

        // Demo accounts
        if (hasLocal && methods.local.showDemoAccounts && authMethod === 'local') {
          var demo = createElement('div', 'ag-demo');
          var d1 = document.createElement('div');
          d1.textContent = t('demoAccounts');
          demo.appendChild(d1);
          var d2 = document.createElement('div');
          d2.textContent = t('demoAdmin');
          demo.appendChild(d2);
          var d3 = document.createElement('div');
          d3.textContent = t('demoUser');
          demo.appendChild(d3);
          card.appendChild(demo);
        }

        // Auto-focus username after render
        setTimeout(function () {
          usernameInput.focus();
        }, 50);
      }
    }

    // No auth methods
    if (!hasOidc && !hasNtlm && !hasUsernamePassword) {
      var noAuth = createElement('div', '');
      noAuth.style.textAlign = 'center';
      noAuth.style.color = 'var(--ag-text-secondary)';
      noAuth.style.padding = '20px 0';
      var p1 = document.createElement('p');
      p1.textContent = t('noAuthMethods');
      noAuth.appendChild(p1);
      var p2 = document.createElement('p');
      p2.textContent = t('contactAdmin');
      p2.style.fontSize = '13px';
      p2.style.marginTop = '8px';
      noAuth.appendChild(p2);
      card.appendChild(noAuth);
    }

    root.textContent = '';
    root.appendChild(card);
  }

  // =========================================================================
  // Login Handlers
  // =========================================================================

  function handleFormSubmit(root) {
    if (isSubmitting) return;

    var usernameEl = root.querySelector('#ag-username');
    var passwordEl = root.querySelector('#ag-password');
    var providerEl = root.querySelector('#ag-provider');

    var username = usernameEl ? usernameEl.value.trim() : '';
    var password = passwordEl ? passwordEl.value : '';
    var provider = providerEl ? providerEl.value : '';

    if (!username || !password) return;

    isSubmitting = true;
    currentError = null;

    // Update button to loading state
    var submitBtn = root.querySelector('#ag-submit-btn');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = '';
      var spinner = createElement('span', 'ag-spinner');
      submitBtn.appendChild(spinner);
      submitBtn.appendChild(document.createTextNode(t('signingIn')));
    }

    // Disable inputs
    setFormDisabled(root, true);

    var authMethod =
      selectedAuthMethod ||
      (authConfig.authMethods.local && authConfig.authMethods.local.enabled ? 'local' : 'ldap');
    var endpoint = authMethod === 'local' ? '/auth/local/login' : '/auth/ldap/login';
    var body = { username: username, password: password };
    if (authMethod === 'ldap' && provider) {
      body.provider = provider;
    }

    postLogin(endpoint, body)
      .then(function (data) {
        isSubmitting = false;

        if (data.success && data.token) {
          storeToken(data.token);
          currentError = null;

          // Clean ?logout=true from URL so the app doesn't think we just logged out
          cleanUrlParams(['logout']);

          // Dispatch success event so React app refreshes its auth state
          window.dispatchEvent(new CustomEvent('authGateSuccess'));

          if (root.classList.contains('ag-overlay')) {
            hideGate();
          } else {
            loadApp();
          }
        } else {
          currentError = data.error || t('invalidCredentials');
          renderAuthUI(root);
        }
      })
      .catch(function () {
        isSubmitting = false;
        currentError = t('connectionError');
        renderAuthUI(root);
      });
  }

  function handleOidcLogin(providerName) {
    // Store return URL
    var returnUrl = window.location.href.split('?')[0];
    try {
      sessionStorage.setItem('authReturnUrl', returnUrl);
    } catch (e) {
      /* ignore */
    }

    var url =
      API_BASE +
      '/auth/oidc/' +
      encodeURIComponent(providerName) +
      '?returnUrl=' +
      encodeURIComponent(returnUrl);
    window.location.href = url;
  }

  function handleNtlmLogin() {
    var returnUrl = window.location.href.split('?')[0];
    var url = API_BASE + '/auth/ntlm/login?returnUrl=' + encodeURIComponent(returnUrl);
    window.location.href = url;
  }

  // =========================================================================
  // Auto-Redirect Logic
  // =========================================================================

  function shouldAutoRedirect(provider) {
    try {
      var key = 'autoRedirect_' + provider;
      var last = sessionStorage.getItem(key);
      if (!last) return true;
      // Only redirect if last attempt was > 5 minutes ago
      return Date.now() - parseInt(last, 10) > 5 * 60 * 1000;
    } catch (e) {
      return true;
    }
  }

  function markAutoRedirectAttempt(provider) {
    try {
      sessionStorage.setItem('autoRedirect_' + provider, Date.now().toString());
    } catch (e) {
      /* ignore */
    }
  }

  // =========================================================================
  // Token Management
  // =========================================================================

  function getStoredToken() {
    try {
      return localStorage.getItem('authToken');
    } catch (e) {
      return null;
    }
  }

  function storeToken(token) {
    try {
      localStorage.setItem('authToken', token);
    } catch (e) {
      /* ignore */
    }
  }

  function removeToken() {
    try {
      localStorage.removeItem('authToken');
    } catch (e) {
      /* ignore */
    }
  }

  // =========================================================================
  // Utilities
  // =========================================================================

  function cleanUrlParams(paramsToRemove) {
    var url = new URL(window.location.href);
    paramsToRemove.forEach(function (p) {
      url.searchParams.delete(p);
    });
    var clean = url.pathname + (url.search || '') + (url.hash || '');
    window.history.replaceState({}, document.title, clean);
  }

  function setFormDisabled(root, disabled) {
    var inputs = root.querySelectorAll('.ag-input, .ag-select, .ag-btn');
    inputs.forEach(function (el) {
      el.disabled = disabled;
    });
  }

  function createElement(tag, className) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    return el;
  }

  function buildDivider() {
    var div = createElement('div', 'ag-divider');
    var span = createElement('span', 'ag-divider-text');
    span.textContent = t('or');
    div.appendChild(span);
    return div;
  }

  function getProviderIcon(name) {
    var n = (name || '').toLowerCase();
    if (n.indexOf('google') !== -1) return '\uD83D\uDD0D';
    if (n.indexOf('microsoft') !== -1 || n.indexOf('azure') !== -1) return '\uD83C\uDFE2';
    if (n.indexOf('github') !== -1) return '\uD83D\uDCBB';
    return '\uD83D\uDD11';
  }
})();
