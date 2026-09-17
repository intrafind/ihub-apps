import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';

// Declarative description of every editable error / empty-state screen.
// Each field maps to a localized `{ en, de, ... }` object under
// `errorPages.<pageKey>.<fieldKey>` in ui.json. Any unset value falls back to
// the bundled i18n string, so leaving a field empty keeps the default text.
const ERROR_PAGES = [
  {
    key: 'generic',
    labelKey: 'admin.ui.errorPages.generic',
    labelDefault: 'Generic Error',
    descKey: 'admin.ui.errorPages.genericDesc',
    descDefault: 'Shown by the application error boundary when an unexpected error occurs.',
    fields: [
      { key: 'title', type: 'text' },
      { key: 'description', type: 'textarea' }
    ]
  },
  {
    key: 'notFound',
    labelKey: 'admin.ui.errorPages.notFound',
    labelDefault: 'Not Found (404)',
    descKey: 'admin.ui.errorPages.notFoundDesc',
    descDefault: 'Shown when a page or resource cannot be found.',
    fields: [
      { key: 'title', type: 'text' },
      { key: 'message', type: 'textarea' }
    ]
  },
  {
    key: 'serverError',
    labelKey: 'admin.ui.errorPages.serverError',
    labelDefault: 'Server Error (500)',
    descKey: 'admin.ui.errorPages.serverErrorDesc',
    descDefault: 'Shown when the server returns an internal error.',
    fields: [
      { key: 'title', type: 'text' },
      { key: 'message', type: 'textarea' },
      { key: 'subtitle', type: 'textarea' }
    ]
  },
  {
    key: 'forbidden',
    labelKey: 'admin.ui.errorPages.forbidden',
    labelDefault: 'Forbidden (403)',
    descKey: 'admin.ui.errorPages.forbiddenDesc',
    descDefault: 'Shown when access to a resource is not allowed.',
    fields: [
      { key: 'title', type: 'text' },
      { key: 'message', type: 'textarea' }
    ]
  },
  {
    key: 'unauthorized',
    labelKey: 'admin.ui.errorPages.unauthorized',
    labelDefault: 'Unauthorized (401)',
    descKey: 'admin.ui.errorPages.unauthorizedDesc',
    descDefault: 'Shown when the user is not authenticated / lacks permission.',
    fields: [
      { key: 'title', type: 'text' },
      { key: 'message', type: 'textarea' }
    ]
  },
  {
    key: 'noApps',
    labelKey: 'admin.ui.errorPages.noApps',
    labelDefault: 'No Apps Available',
    descKey: 'admin.ui.errorPages.noAppsDesc',
    descDefault: 'Shown on the apps list when the server returns no applications.',
    fields: [
      { key: 'title', type: 'text' },
      { key: 'message', type: 'textarea' }
    ]
  }
];

const FIELD_LABELS = {
  title: { key: 'admin.ui.errorPages.field.title', default: 'Title' },
  message: { key: 'admin.ui.errorPages.field.message', default: 'Message' },
  description: { key: 'admin.ui.errorPages.field.description', default: 'Description' },
  subtitle: { key: 'admin.ui.errorPages.field.subtitle', default: 'Subtitle' }
};

function ErrorPagesCustomization({ config, onUpdate, t }) {
  const errorPages = config || {};

  const updateField = (pageKey, fieldKey, value) => {
    onUpdate({
      [pageKey]: {
        ...(errorPages[pageKey] || {}),
        [fieldKey]: value
      }
    });
  };

  return (
    <div className="p-6 space-y-8">
      <div>
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-1">
          {t('admin.ui.errorPages.title', 'Error & Empty-State Messages')}
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t(
            'admin.ui.errorPages.subtitle',
            'Customize the localized text shown on error and empty-state screens. Leave a field empty to use the built-in default text.'
          )}
        </p>
      </div>

      {ERROR_PAGES.map(page => (
        <fieldset
          key={page.key}
          className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-4"
        >
          <legend className="px-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t(page.labelKey, page.labelDefault)}
          </legend>
          <p className="text-xs text-gray-500 dark:text-gray-400 -mt-2">
            {t(page.descKey, page.descDefault)}
          </p>

          {page.fields.map(field => {
            const fieldLabel = FIELD_LABELS[field.key];
            return (
              <DynamicLanguageEditor
                key={field.key}
                label={t(fieldLabel.key, fieldLabel.default)}
                value={errorPages[page.key]?.[field.key] || {}}
                onChange={value => updateField(page.key, field.key, value)}
                type={field.type}
                placeholder={{
                  en: `${t(fieldLabel.key, fieldLabel.default)} (en)`,
                  de: `${t(fieldLabel.key, fieldLabel.default)} (de)`
                }}
              />
            );
          })}
        </fieldset>
      ))}
    </div>
  );
}

export default ErrorPagesCustomization;
