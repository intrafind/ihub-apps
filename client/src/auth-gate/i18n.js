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
      demoAccounts: 'Demo accounts:',
      demoAdmin: 'Admin: admin / password123',
      demoUser: 'User: user / password123'
    },
    de: {
      signIn: 'Anmelden',
      signInWith: 'Anmelden mit:',
      username: 'Benutzername oder E-Mail',
      password: 'Passwort',
      usernamePlaceholder: 'Benutzername oder E-Mail eingeben',
      passwordPlaceholder: 'Passwort eingeben',
      signingIn: 'Anmeldung...',
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
      demoAccounts: 'Demo-Konten:',
      demoAdmin: 'Admin: admin / password123',
      demoUser: 'Benutzer: user / password123'
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
