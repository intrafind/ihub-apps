// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Minimal i18n module for the auth gate.
 * Bundled inline — no runtime loading required.
 * Language detection matches the main app's i18next configuration.
 */
var __authGateI18n = (function () {
  var translations = {
    en: {
      signIn: 'Sign In',
      signInWith: 'Sign in with:',
      username: 'Username or Email',
      password: 'Password',
      usernamePlaceholder: 'Enter your username or email',
      passwordPlaceholder: 'Enter your password',
      signingIn: 'Signing in...',
      rememberMe: 'Remember me',
      invalidCredentials: 'Invalid username or password',
      connectionError: 'Connection error. Please try again.',
      windowsAuth: 'Windows Authentication',
      selectAuthMethod: 'Select authentication method:',
      localAuth: 'Username / Password',
      ldapAuth: 'LDAP / Domain',
      ldapProvider: 'LDAP Provider',
      autoDetect: 'Auto-detect',
      backToMethods: 'Back to method selection',
      or: 'or',
      noAuthMethods: 'No authentication methods are currently enabled.',
      contactAdmin: 'Please contact your administrator.',
      loading: 'Loading...',
      retry: 'Retry',
      serverError: 'Unable to connect to the server.',
      sessionExpired: 'Your session has expired. Please sign in again.',
      signInFailed:
        'Sign-in did not complete. Please try again. If it keeps failing, contact your administrator.',
      demoAccounts: 'Demo accounts:',
      demoAdmin: 'Admin: admin / password123',
      demoUser: 'User: user / password123',
      close: 'Close',
      signInInProgress:
        'Finish signing in in the window that opened. This page continues on its own.',
      signInPopupBlocked:
        'Your browser blocked the sign-in window. Allow pop-ups for this site and try again.',
      signInWindowClosed:
        'The sign-in window was closed before the sign-in was finished. Please try again.',
      embedSignInDisabled:
        'Signing in inside another site is not enabled. Ask your administrator, or open iHub in its own tab.',
      embedSignInUnavailable:
        'Signing in is not possible here. A secure connection (HTTPS) is required.',
      embedSignInCookieBlocked:
        'The sign-in worked, but your browser did not keep the session for this page. Check that cookies are not blocked, or open iHub in its own tab.'
    },
    de: {
      signIn: 'Anmelden',
      signInWith: 'Anmelden mit:',
      username: 'Benutzername oder E-Mail',
      password: 'Passwort',
      usernamePlaceholder: 'Benutzername oder E-Mail eingeben',
      passwordPlaceholder: 'Passwort eingeben',
      signingIn: 'Anmeldung...',
      rememberMe: 'Angemeldet bleiben',
      invalidCredentials: 'Ung\u00fcltiger Benutzername oder Passwort',
      connectionError: 'Verbindungsfehler. Bitte versuchen Sie es erneut.',
      windowsAuth: 'Windows-Authentifizierung',
      selectAuthMethod: 'Authentifizierungsmethode ausw\u00e4hlen:',
      localAuth: 'Username / Passwort',
      ldapAuth: 'LDAP / Dom\u00e4ne',
      ldapProvider: 'LDAP-Anbieter',
      autoDetect: 'Automatisch erkennen',
      backToMethods: 'Zur\u00fcck zur Auswahl',
      or: 'oder',
      noAuthMethods: 'Derzeit sind keine Authentifizierungsmethoden aktiviert.',
      contactAdmin: 'Bitte kontaktieren Sie Ihren Administrator.',
      loading: 'Laden...',
      retry: 'Erneut versuchen',
      serverError: 'Verbindung zum Server konnte nicht hergestellt werden.',
      sessionExpired: 'Ihre Sitzung ist abgelaufen. Bitte melden Sie sich erneut an.',
      signInFailed:
        'Die Anmeldung wurde nicht abgeschlossen. Bitte versuchen Sie es erneut. Wenn sie weiterhin fehlschlägt, wenden Sie sich an Ihren Administrator.',
      demoAccounts: 'Demo-Konten:',
      demoAdmin: 'Admin: admin / password123',
      demoUser: 'Benutzer: user / password123',
      close: 'Schließen',
      signInInProgress:
        'Schließen Sie die Anmeldung im geöffneten Fenster ab. Diese Seite wird danach automatisch fortgesetzt.',
      signInPopupBlocked:
        'Ihr Browser hat das Anmeldefenster blockiert. Erlauben Sie Pop-ups für diese Website und versuchen Sie es erneut.',
      signInWindowClosed:
        'Das Anmeldefenster wurde geschlossen, bevor die Anmeldung abgeschlossen war. Bitte versuchen Sie es erneut.',
      embedSignInDisabled:
        'Die Anmeldung innerhalb einer anderen Website ist nicht aktiviert. Wenden Sie sich an Ihren Administrator oder öffnen Sie iHub in einem eigenen Tab.',
      embedSignInUnavailable:
        'Die Anmeldung ist hier nicht möglich. Eine sichere Verbindung (HTTPS) ist erforderlich.',
      embedSignInCookieBlocked:
        'Die Anmeldung war erfolgreich, aber Ihr Browser hat die Sitzung für diese Seite nicht behalten. Prüfen Sie, ob Cookies blockiert werden, oder öffnen Sie iHub in einem eigenen Tab.'
    }
  };

  function detectLanguage() {
    // 1. Check i18next stored language (matches main app)
    try {
      var stored = localStorage.getItem('i18nextLng');
      if (stored) {
        var normalized = stored.split('-')[0].toLowerCase();
        if (translations[normalized]) return normalized;
      }
    } catch (e) {
      // localStorage may be unavailable
    }
    // 2. Check browser language
    var nav = (navigator.language || 'en').split('-')[0].toLowerCase();
    return translations[nav] ? nav : 'en';
  }

  function t(key) {
    var lang = detectLanguage();
    return (translations[lang] && translations[lang][key]) || translations.en[key] || key;
  }

  return { t: t, detectLanguage: detectLanguage };
})();
