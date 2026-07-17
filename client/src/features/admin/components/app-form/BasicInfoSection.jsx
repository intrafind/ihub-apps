import DynamicLanguageEditor from '../../../../shared/components/DynamicLanguageEditor';
import IconPicker from '../../../../shared/components/IconPicker';
import ResourceSelector from '../ResourceSelector';
import { getLocalizedContent } from '../../../../utils/localizeContent';
import { isFieldRequired } from '../../../../utils/schemaValidation';
import parseNumberOrUndefined from '../../utils/parseNumberOrUndefined';

function BasicInfoSection({
  app,
  onChange,
  t,
  currentLanguage,
  uiConfig,
  availableModels = [],
  validationErrors,
  jsonSchema
}) {
  const handleInputChange = (field, value) => {
    onChange({ ...app, [field]: value });
  };

  const handleLocalizedChange = (field, value) => {
    onChange({ ...app, [field]: value });
  };

  const handleAllowedModelsChange = selectedModelIds => {
    onChange({ ...app, allowedModels: selectedModelIds });
  };

  return (
    <div className="bg-white dark:bg-gray-800 shadow px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:grid md:grid-cols-3 md:gap-6">
        <div className="md:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.basicInfo', 'Basic Information')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t('admin.apps.edit.basicInfoDesc', 'Basic app configuration and metadata')}
          </p>
        </div>
        <div className="mt-5 md:col-span-2 md:mt-0">
          <div className="grid grid-cols-6 gap-6">
            <div className="col-span-6 sm:col-span-3">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('admin.apps.edit.appId', 'App ID')}
                {isFieldRequired('id', jsonSchema) && <span className="text-red-500 ml-1">*</span>}
              </label>
              <input
                id="id"
                type="text"
                required={isFieldRequired('id', jsonSchema)}
                value={app.id || ''}
                onChange={e => handleInputChange('id', e.target.value)}
                className={`mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm ${
                  validationErrors.id ? 'border-red-300' : ''
                }`}
                aria-invalid={!!validationErrors.id || undefined}
                aria-describedby={validationErrors.id ? 'id-error' : undefined}
              />
              {validationErrors.id && (
                <p
                  id="id-error"
                  role="alert"
                  className="mt-1 text-sm text-red-600 dark:text-red-400"
                >
                  {validationErrors.id}
                </p>
              )}
            </div>

            <div className="col-span-6 sm:col-span-3">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('admin.apps.edit.appType', 'App Type')}
                <span className="text-red-500 ml-1">*</span>
              </label>
              <select
                value={app.type || 'chat'}
                onChange={e => handleInputChange('type', e.target.value)}
                className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
              >
                <option value="chat">{t('admin.apps.edit.typeChat', 'Chat')}</option>
                <option value="iframe">{t('admin.apps.edit.typeIframe', 'Iframe')}</option>
                <option value="redirect">{t('admin.apps.edit.typeRedirect', 'Redirect')}</option>
              </select>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {t(
                  'admin.apps.edit.appTypeHint',
                  'Chat apps use AI models, Iframe apps embed external content, Redirect apps open external links'
                )}
              </p>
            </div>

            <div className="col-span-6 sm:col-span-3">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('admin.apps.edit.order', 'Order')}
              </label>
              <input
                type="number"
                value={app.order || 0}
                onChange={e => handleInputChange('order', parseInt(e.target.value) || 0)}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
              />
            </div>

            <div className="col-span-6 sm:col-span-3">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('admin.apps.edit.category', 'Category')}
              </label>
              <select
                value={app.category || ''}
                onChange={e => handleInputChange('category', e.target.value)}
                className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
              >
                <option value="">
                  {t('admin.apps.edit.selectCategory', 'Select category...')}
                </option>
                {uiConfig?.appsList?.categories?.list
                  ?.filter(cat => cat.id !== 'all')
                  .map(category => (
                    <option key={category.id} value={category.id}>
                      {getLocalizedContent(category.name, currentLanguage)}
                    </option>
                  ))}
              </select>
            </div>

            <div className="col-span-6">
              <DynamicLanguageEditor
                label={
                  <span>
                    {t('admin.apps.edit.name', 'Name')}
                    <span className="text-red-500 ml-1">*</span>
                  </span>
                }
                value={app.name || {}}
                onChange={value => handleLocalizedChange('name', value)}
                required={true}
                placeholder={{
                  en: 'Enter app name in English',
                  de: 'App-Name auf Deutsch eingeben'
                }}
                error={validationErrors.name}
                name="name"
              />
            </div>

            <div className="col-span-6">
              <DynamicLanguageEditor
                label={
                  <span>
                    {t('admin.apps.edit.description', 'Description')}
                    <span className="text-red-500 ml-1">*</span>
                  </span>
                }
                value={app.description || {}}
                onChange={value => handleLocalizedChange('description', value)}
                required={true}
                type="textarea"
                placeholder={{
                  en: 'Enter app description in English',
                  de: 'App-Beschreibung auf Deutsch eingeben'
                }}
                error={validationErrors.description}
                name="description"
              />
            </div>

            <div className="col-span-6 sm:col-span-3">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('admin.apps.edit.color', 'Color')}
                <span className="text-red-500 ml-1">*</span>
              </label>
              <input
                id="color"
                type="color"
                value={app.color || '#4F46E5'}
                onChange={e => handleInputChange('color', e.target.value)}
                className={`mt-1 block w-full h-10 rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm ${
                  validationErrors.color ? 'border-red-300' : ''
                }`}
                aria-invalid={!!validationErrors.color || undefined}
                aria-describedby={validationErrors.color ? 'color-error' : undefined}
              />
              {validationErrors.color && (
                <p
                  id="color-error"
                  role="alert"
                  className="mt-1 text-sm text-red-600 dark:text-red-400"
                >
                  {validationErrors.color}
                </p>
              )}
            </div>

            <div className="col-span-6 sm:col-span-3">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('admin.apps.edit.icon', 'Icon')}
                <span className="text-red-500 ml-1">*</span>
              </label>
              <div data-field="icon">
                <IconPicker
                  value={app.icon || ''}
                  onChange={value => handleInputChange('icon', value)}
                  error={validationErrors.icon}
                  className="mt-1"
                />
              </div>
            </div>

            <div className="col-span-6 sm:col-span-3">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('admin.apps.edit.preferredModel', 'Preferred Model')}
              </label>
              <select
                value={app.preferredModel || ''}
                onChange={e => handleInputChange('preferredModel', e.target.value)}
                className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
              >
                <option value="">{t('admin.apps.edit.selectModel', 'Select model...')}</option>
                {availableModels.map(model => (
                  <option key={model.id} value={model.id}>
                    {getLocalizedContent(model.name, currentLanguage)}
                  </option>
                ))}
              </select>
            </div>

            <div className="col-span-6">
              <ResourceSelector
                label={t('admin.apps.edit.allowedModels', 'Allowed Models')}
                resources={availableModels}
                selectedResources={app.allowedModels || []}
                onSelectionChange={handleAllowedModelsChange}
                allowWildcard={false}
                placeholder={t('admin.apps.edit.searchModels', 'Search models to add...')}
                emptyMessage={t(
                  'admin.apps.edit.noModelsSelected',
                  'No restriction — all available models can be used with this app'
                )}
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {t(
                  'admin.apps.edit.allowedModelsHint',
                  'Restrict which models users can select for this app. Leave empty to allow all models.'
                )}
              </p>
            </div>

            <div className="col-span-6 sm:col-span-3">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('admin.apps.edit.temperature', 'Temperature')}
              </label>
              <input
                type="number"
                min="0"
                max="2"
                step="0.1"
                value={app.preferredTemperature || 0.7}
                onChange={e =>
                  handleInputChange('preferredTemperature', parseNumberOrUndefined(e.target.value))
                }
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
              />
            </div>

            <div className="col-span-6 sm:col-span-3">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('admin.apps.edit.outputFormat', 'Output Format')}
              </label>
              <select
                value={app.preferredOutputFormat || 'markdown'}
                onChange={e => handleInputChange('preferredOutputFormat', e.target.value)}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
              >
                <option value="markdown">{t('appConfig.markdown', 'Markdown')}</option>
                <option value="text">{t('appConfig.plainText', 'Plain Text')}</option>
                <option value="json">{t('appConfig.json', 'JSON')}</option>
                <option value="html">{t('appConfig.html', 'HTML')}</option>
              </select>
            </div>

            <div className="col-span-6">
              <div className="flex items-center">
                <input
                  type="checkbox"
                  checked={app.enabled !== false}
                  onChange={e => handleInputChange('enabled', e.target.checked)}
                  className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded"
                />
                <label className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
                  {t('admin.apps.edit.enabled', 'Enabled')}
                </label>
              </div>
            </div>

            {/* Auto-start - Only for chat apps */}
            {(app.type === 'chat' || !app.type) && (
              <div className="col-span-6">
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    checked={app.autoStart === true}
                    onChange={e => handleInputChange('autoStart', e.target.checked)}
                    className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded"
                  />
                  <label className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
                    {t('admin.apps.edit.autoStart', 'Auto-start conversation')}
                  </label>
                </div>
                <p className="mt-1 ml-6 text-xs text-gray-500 dark:text-gray-400">
                  {t(
                    'admin.apps.edit.autoStartHelp',
                    'When enabled, the app will automatically start the conversation when the chat is opened or reset'
                  )}
                </p>
              </div>
            )}

            {/* Ephemeral chat - Only for chat apps */}
            {(app.type === 'chat' || !app.type) && (
              <div className="col-span-6">
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    checked={app.ephemeral === true}
                    onChange={e => handleInputChange('ephemeral', e.target.checked)}
                    className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 rounded"
                  />
                  <label className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
                    {t('admin.apps.edit.ephemeral', 'Ephemeral chat')}
                  </label>
                </div>
                <p className="mt-1 ml-6 text-xs text-gray-500 dark:text-gray-400">
                  {t(
                    'admin.apps.edit.ephemeralHelp',
                    'When enabled, the chat is never stored. Messages exist only while the chat is open and are discarded when you switch apps or reload.'
                  )}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default BasicInfoSection;
