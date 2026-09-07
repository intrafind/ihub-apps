/**
 * Migration V078 — Add error-page messages section to ui.json
 *
 * Seeds the `errorPages` top-level section into existing ui.json configs so
 * administrators can customize the localized text shown on error and
 * empty-state screens (generic error boundary, 404, 500, 403, 401, and the
 * "no apps available" state).
 *
 * Each field is a localized `{ en, de, ... }` object and is only added when
 * missing, so any value an admin has already set is preserved. Screens fall
 * back to their bundled i18n strings whenever a field is left unset, so this
 * migration does not change existing behavior — it just exposes the defaults
 * for editing.
 */

export const version = '078';
export const description = 'Add error-page messages section to ui.json';

export async function precondition(ctx) {
  return await ctx.fileExists('config/ui.json');
}

export async function up(ctx) {
  const ui = await ctx.readJson('config/ui.json');

  // Generic error boundary
  ctx.setDefault(ui, 'errorPages.generic.title', {
    en: 'Something went wrong',
    de: 'Etwas ist schiefgelaufen'
  });
  ctx.setDefault(ui, 'errorPages.generic.description', {
    en: 'An unexpected error occurred in the application. The development team has been notified.',
    de: 'Ein unerwarteter Fehler ist in der Anwendung aufgetreten. Das Entwicklungsteam wurde benachrichtigt.'
  });

  // Not Found (404)
  ctx.setDefault(ui, 'errorPages.notFound.title', {
    en: 'Page Not Found',
    de: 'Seite nicht gefunden'
  });
  ctx.setDefault(ui, 'errorPages.notFound.message', {
    en: "We couldn't find the page you're looking for.",
    de: 'Die gesuchte Seite konnte nicht gefunden werden.'
  });

  // Server Error (500)
  ctx.setDefault(ui, 'errorPages.serverError.title', {
    en: 'Server Error',
    de: 'Serverfehler'
  });
  ctx.setDefault(ui, 'errorPages.serverError.message', {
    en: 'Something went wrong on our end.',
    de: 'Auf unserer Seite ist etwas schiefgelaufen.'
  });
  ctx.setDefault(ui, 'errorPages.serverError.subtitle', {
    en: 'Please try again later.',
    de: 'Bitte versuchen Sie es später erneut.'
  });

  // Forbidden (403)
  ctx.setDefault(ui, 'errorPages.forbidden.title', {
    en: 'Forbidden',
    de: 'Zugriff verweigert'
  });
  ctx.setDefault(ui, 'errorPages.forbidden.message', {
    en: 'Access to this resource is forbidden.',
    de: 'Der Zugriff auf diese Ressource ist nicht erlaubt.'
  });

  // Unauthorized (401)
  ctx.setDefault(ui, 'errorPages.unauthorized.title', {
    en: 'Unauthorized',
    de: 'Nicht autorisiert'
  });
  ctx.setDefault(ui, 'errorPages.unauthorized.message', {
    en: "You don't have permission to access this page.",
    de: 'Sie haben keine Berechtigung, auf diese Seite zuzugreifen.'
  });

  // No apps available (apps list empty state)
  ctx.setDefault(ui, 'errorPages.noApps.title', {
    en: 'No apps available from server',
    de: 'Keine Apps vom Server verfügbar'
  });
  ctx.setDefault(ui, 'errorPages.noApps.message', {
    en: 'Check if the server is running and returning data correctly.',
    de: 'Prüfen Sie, ob der Server läuft und Daten korrekt zurückgibt.'
  });

  await ctx.writeJson('config/ui.json', ui);
  ctx.log('Applied error-page message defaults');
}
