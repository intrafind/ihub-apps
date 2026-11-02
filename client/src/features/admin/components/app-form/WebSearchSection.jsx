// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import Switch from '../../../../shared/components/Switch';
import { CALLOUT_CLASS } from '../formStyles';
import { AUTO_ENGINE, webSearchEngineStatus } from './webSearchEngines';

/**
 * WebSearchSection - Web search configuration card for the App form.
 * Extracted from AppFormEditor.jsx (see #1781) as a self-contained slice:
 * only ever reads/writes `app.websearch` via the passed-in onChange.
 *
 * Rendered by IntegrationsConfigSection for every chat app: native search
 * needs no engine, so web search is always possible. The engine select lists
 * **Auto** and the installed engines (installations of type `web-search`),
 * disabled ones marked; an engine the app names that is not installed is
 * kept in the list and warned about.
 *
 * @param {Object} props
 * @param {Object} props.app - the app being edited
 * @param {(app: Object) => void} props.onChange - receives the whole changed app
 * @param {Array<Object>|null} [props.engines] - the engine installations in
 *   Auto's order (`webSearchEnginesOf`); null while unknown (not loaded)
 */
function WebSearchSection({ app, onChange, engines = null }) {
  const { t } = useTranslation();
  const provider = app.websearch?.provider || AUTO_ENGINE;
  const engineStatus = webSearchEngineStatus(provider, engines);
  const engineList = Array.isArray(engines) ? engines : [];
  const engineLabel = engine =>
    engine.label && engine.label !== engine.id ? `${engine.label} (${engine.id})` : engine.id;

  const handleWebSearchChange = updates => {
    onChange({
      ...app,
      websearch: {
        ...app.websearch,
        ...updates
      }
    });
  };

  // researchGuidance: true/unset = built-in text, false = off, string = custom text
  const researchGuidance = app.websearch?.researchGuidance;
  const researchGuidanceOn = researchGuidance !== false;
  const customResearchGuidance = typeof researchGuidance === 'string' ? researchGuidance : '';

  return (
    <div className="bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:grid md:grid-cols-3 md:gap-6">
        <div className="md:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.websearch', 'Web Search')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t('admin.apps.edit.websearchDesc', 'Configure web search capabilities for this app')}
          </p>
        </div>
        <div className="mt-5 md:mt-0 md:col-span-2 space-y-4">
          {/* Enable Web Search toggle */}
          <div className="flex items-center justify-between">
            <label
              htmlFor="websearch-enabled"
              className="text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              {t('admin.apps.edit.websearchEnabled', 'Enable Web Search')}
            </label>
            <Switch
              id="websearch-enabled"
              checked={app.websearch?.enabled ?? false}
              onChange={enabled => handleWebSearchChange({ enabled })}
            />
          </div>

          {/* Web Search settings - only shown when enabled */}
          {app.websearch?.enabled && (
            <div className="space-y-4 pl-1">
              {/* Engine */}
              <div>
                <label
                  htmlFor="websearch-engine"
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                >
                  {t('admin.apps.edit.websearchProvider', 'Search engine')}
                </label>
                <select
                  id="websearch-engine"
                  value={provider}
                  onChange={e => handleWebSearchChange({ provider: e.target.value })}
                  aria-describedby="websearch-engine-desc"
                  className="mt-1 block w-full rounded-lg border-gray-300 shadow-xs focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
                >
                  <option value={AUTO_ENGINE}>
                    {t('admin.apps.edit.websearchProviderAuto', 'Auto')}
                  </option>
                  {engineList.map(engine => (
                    <option key={engine.id} value={engine.id}>
                      {engine.enabled === false
                        ? t(
                            'admin.apps.edit.websearchEngineDisabledOption',
                            '{{name}} — disabled',
                            {
                              name: engineLabel(engine)
                            }
                          )
                        : engineLabel(engine)}
                    </option>
                  ))}
                  {/* The named engine, when the list does not have it: not
                      installed, or the list failed to load (`unknown`). Without
                      it the select would show Auto for a stored engine. */}
                  {(engineStatus === 'missing' || engineStatus === 'unknown') && (
                    <option value={provider}>
                      {engineStatus === 'missing'
                        ? t(
                            'admin.apps.edit.websearchEngineMissingOption',
                            '{{name}} — not installed',
                            { name: provider }
                          )
                        : provider}
                    </option>
                  )}
                </select>
                <p
                  id="websearch-engine-desc"
                  className="mt-1 text-xs text-gray-500 dark:text-gray-400"
                >
                  {t(
                    'admin.apps.edit.websearchProviderDesc',
                    'Models with native search (Google, OpenAI, Anthropic) search themselves when Use Native Search is on; no engine is needed for that. On other models the app uses this engine. Auto takes the first engine the user may use: Brave, Staan, Qwant, then any other engine.'
                  )}
                </p>
                {engineStatus === 'missing' && (
                  <p
                    className={`mt-2 ${CALLOUT_CLASS.warning}`}
                    role="alert"
                    data-testid="websearch-engine-missing"
                  >
                    {t(
                      'admin.apps.edit.websearchEngineMissing',
                      'The engine "{{engine}}" is not installed. The app searches natively where the model can and not at all on other models. Install it under Integrations or pick Auto.',
                      { engine: provider }
                    )}
                  </p>
                )}
                {engineStatus === 'disabled' && (
                  <p
                    className={`mt-2 ${CALLOUT_CLASS.warning}`}
                    data-testid="websearch-engine-disabled"
                  >
                    {t(
                      'admin.apps.edit.websearchEngineDisabled',
                      'The engine "{{engine}}" is disabled. Until it is enabled, the app searches natively where the model can and not at all on other models.',
                      { engine: provider }
                    )}
                  </p>
                )}
                {Array.isArray(engines) && engines.length === 0 && (
                  <p className={`mt-2 ${CALLOUT_CLASS.info}`} data-testid="websearch-no-engine">
                    {t(
                      'admin.apps.edit.websearchNoEngine',
                      'No search engine is installed: the app searches only on models with native search.'
                    )}{' '}
                    <Link
                      to="/admin/integrations?tab=catalog"
                      className="underline hover:no-underline"
                    >
                      {t('admin.apps.edit.websearchInstallEngine', 'Install an engine')}
                    </Link>
                  </p>
                )}
              </div>

              {/* Use Native Search */}
              <div className="flex items-center justify-between">
                <div>
                  <label
                    htmlFor="websearch-use-native"
                    className="text-sm font-medium text-gray-700 dark:text-gray-300"
                  >
                    {t('admin.apps.edit.websearchUseNative', 'Use Native Search')}
                  </label>
                  <p
                    id="websearch-use-native-desc"
                    className="text-xs text-gray-500 dark:text-gray-400"
                  >
                    {t(
                      'admin.apps.edit.websearchUseNativeDesc',
                      "Use the model's built-in search when available (e.g. Google, OpenAI, Anthropic)"
                    )}
                  </p>
                </div>
                <Switch
                  id="websearch-use-native"
                  className="ml-4"
                  checked={app.websearch?.useNativeSearch ?? true}
                  onChange={value => handleWebSearchChange({ useNativeSearch: value })}
                  aria-describedby="websearch-use-native-desc"
                />
              </div>

              {/* Max Searches per model call (native search cap) */}
              {(app.websearch?.useNativeSearch ?? true) && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    {t('admin.apps.edit.websearchMaxSearches', 'Max Searches per Answer')}
                  </label>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {t(
                      'admin.apps.edit.websearchMaxSearchesDesc',
                      'Caps how many searches the model may run per call with native search (Anthropic bills each search). 1–50, default 5.'
                    )}
                  </p>
                  <input
                    type="number"
                    min="1"
                    max="50"
                    value={app.websearch?.maxSearches ?? 5}
                    onChange={e =>
                      handleWebSearchChange({ maxSearches: Number.parseInt(e.target.value) || 5 })
                    }
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-xs focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                  />
                </div>
              )}

              {/* Max page reads per answer (page reader cap) */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t('admin.apps.edit.websearchMaxPageReads', 'Max Page Reads per Answer')}
                </label>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {t(
                    'admin.apps.edit.websearchMaxPageReadsDesc',
                    'Caps how many pages the model may open with the page reader for one answer. Pages the search itself fetches for its excerpts do not count. 1–50, default 5.'
                  )}
                </p>
                <input
                  type="number"
                  min="1"
                  max="50"
                  value={app.websearch?.maxPageReads ?? 5}
                  onChange={e =>
                    handleWebSearchChange({
                      maxPageReads: Math.min(50, Math.max(1, Number.parseInt(e.target.value) || 5))
                    })
                  }
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-xs focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                />
              </div>

              {/* Max Results */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t('admin.apps.edit.websearchMaxResults', 'Max Results')}
                </label>
                <input
                  type="number"
                  min="1"
                  max="20"
                  value={app.websearch?.maxResults ?? 5}
                  onChange={e =>
                    handleWebSearchChange({ maxResults: Number.parseInt(e.target.value) || 5 })
                  }
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-xs focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                />
              </div>

              {/* Extract Content */}
              <div className="flex items-center justify-between">
                <div>
                  <label
                    htmlFor="websearch-extract-content"
                    className="text-sm font-medium text-gray-700 dark:text-gray-300"
                  >
                    {t('admin.apps.edit.websearchExtractContent', 'Extract Content')}
                  </label>
                  <p
                    id="websearch-extract-content-desc"
                    className="text-xs text-gray-500 dark:text-gray-400"
                  >
                    {t(
                      'admin.apps.edit.websearchExtractContentDesc',
                      'Fetch and extract full page content from search results'
                    )}
                  </p>
                </div>
                <Switch
                  id="websearch-extract-content"
                  className="ml-4"
                  checked={app.websearch?.extractContent ?? true}
                  onChange={value => handleWebSearchChange({ extractContent: value })}
                  aria-describedby="websearch-extract-content-desc"
                />
              </div>

              {/* Content Max Length */}
              {(app.websearch?.extractContent ?? true) && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    {t('admin.apps.edit.websearchContentMaxLength', 'Content Max Length')}
                  </label>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {t(
                      'admin.apps.edit.websearchContentMaxLengthDesc',
                      'Maximum characters extracted per page (500–50000)'
                    )}
                  </p>
                  <input
                    type="number"
                    min="500"
                    max="50000"
                    step="500"
                    value={app.websearch?.contentMaxLength ?? 3000}
                    onChange={e =>
                      handleWebSearchChange({
                        contentMaxLength: Number.parseInt(e.target.value) || 3000
                      })
                    }
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-xs focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                  />
                </div>
              )}

              {/* Enabled by Default */}
              <div className="flex items-center justify-between">
                <div>
                  <label
                    htmlFor="websearch-enabled-by-default"
                    className="text-sm font-medium text-gray-700 dark:text-gray-300"
                  >
                    {t('admin.apps.edit.websearchEnabledByDefault', 'Enabled by Default')}
                  </label>
                  <p
                    id="websearch-enabled-by-default-desc"
                    className="text-xs text-gray-500 dark:text-gray-400"
                  >
                    {t(
                      'admin.apps.edit.websearchEnabledByDefaultDesc',
                      'Whether web search is turned on by default for users'
                    )}
                  </p>
                </div>
                <Switch
                  id="websearch-enabled-by-default"
                  className="ml-4"
                  checked={app.websearch?.enabledByDefault ?? false}
                  onChange={value => handleWebSearchChange({ enabledByDefault: value })}
                  aria-describedby="websearch-enabled-by-default-desc"
                />
              </div>

              {/* Required: hide the app while its web search engine is not available */}
              <div className="flex items-center justify-between">
                <div>
                  <label
                    htmlFor="websearch-required"
                    className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                  >
                    {t('admin.apps.edit.websearchRequired', 'Required')}
                  </label>
                  <p
                    id="websearch-required-desc"
                    className="text-xs text-gray-500 dark:text-gray-400"
                  >
                    {t(
                      'admin.apps.edit.websearchRequiredDesc',
                      'Hide the app while its search engine is not available (Auto: no engine is installed and enabled; a named engine: that one is missing or disabled). Off: the app stays available and searches natively where the model can.'
                    )}
                  </p>
                </div>
                <Switch
                  id="websearch-required"
                  className="ml-4"
                  checked={app.websearch?.required ?? false}
                  onChange={required => handleWebSearchChange({ required })}
                  aria-describedby="websearch-required-desc"
                />
              </div>

              {/* Multi-step research guidance */}
              <div className="flex items-center justify-between">
                <div>
                  <label
                    htmlFor="websearch-research-guidance"
                    className="text-sm font-medium text-gray-700 dark:text-gray-300"
                  >
                    {t('admin.apps.edit.websearchResearchGuidance', 'Research in Several Steps')}
                  </label>
                  <p
                    id="websearch-research-guidance-desc"
                    className="text-xs text-gray-500 dark:text-gray-400"
                  >
                    {t(
                      'admin.apps.edit.websearchResearchGuidanceDesc',
                      'Tells the model to run several searches, check sources and combine the findings, instead of answering after one search'
                    )}
                  </p>
                </div>
                <Switch
                  id="websearch-research-guidance"
                  className="ml-4"
                  checked={researchGuidanceOn}
                  onChange={value => handleWebSearchChange({ researchGuidance: value })}
                  aria-describedby="websearch-research-guidance-desc"
                />
              </div>

              {researchGuidanceOn && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    {t(
                      'admin.apps.edit.websearchResearchGuidanceCustom',
                      'Custom Research Guidance'
                    )}
                  </label>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {t(
                      'admin.apps.edit.websearchResearchGuidanceCustomDesc',
                      'Optional. Replaces the built-in guidance that is added to the system prompt when web search is on. Leave empty to use the built-in guidance.'
                    )}
                  </p>
                  <textarea
                    rows={4}
                    maxLength={4000}
                    value={customResearchGuidance}
                    onChange={e =>
                      handleWebSearchChange({ researchGuidance: e.target.value || true })
                    }
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-xs focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default WebSearchSection;
