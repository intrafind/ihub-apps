// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import AdminFormErrorSummary from '../../AdminFormErrorSummary';
import { CredentialRefSelect } from '../../OpenApiToolEditor';
import {
  CALLOUT_CLASS,
  HELP_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  MONO_INPUT_CLASS
} from '../../formStyles';
import {
  fetchInstalledIntegrations,
  fetchPeopleDirectoryEditorContext
} from '../../../../../api/integrationsAdminApi';
import useInstallationEditor from './useInstallationEditor';
import {
  AccessSection,
  ActionsSection,
  EditorFooter,
  EditorSection,
  FieldError,
  NameSection
} from './InstallationEditorParts';
import ChoiceField from './peopleDirectory/ChoiceField';
import TransportBadge from './peopleDirectory/TransportBadge';
import {
  BROWSE_MAX_RESULTS_DEFAULT,
  BROWSE_MAX_RESULTS_LIMIT,
  LDAP_DIRECTORY_DEFINITION_ID,
  browseToolIdsFor,
  browserFormToValues,
  browserValuesToForm,
  validateBrowserForm
} from './peopleDirectoryEditorModel';

const K = 'admin.integrations.editors.ldapBrowser';
const FORM_ID = 'ldap-browser-editor-form';

/** The input of an install field, for the error summary. */
const INPUT_IDS = Object.freeze({
  directory: 'lb-directory',
  baseDn: 'lb-base-dn',
  maxResults: 'lb-max-results',
  bindMode: 'lb-bind-mode-directory',
  bindDn: 'lb-bind-dn',
  bindPasswordRef: 'lb-bind-password-ref',
  denyAttributes: 'lb-deny-attributes'
});

/**
 * One fact row of the chosen directory.
 */
function Fact({ label, children, mono = false }) {
  return (
    <>
      <dt className="font-medium text-gray-700 dark:text-gray-300">{label}</dt>
      <dd
        className={`text-gray-900 dark:text-gray-100 break-all sm:col-span-2 ${mono ? 'font-mono' : ''}`}
      >
        {children}
      </dd>
    </>
  );
}

/**
 * The bind account the chosen directory searches with, as the browser's
 * "directory's account" option shows it: its service account, anonymous, or
 * the bind account of the sign-in provider it reuses (anonymous without one).
 *
 * @param {Object} directoryValues - Install values of the chosen directory
 * @param {Function} t - Translator
 * @returns {string}
 */
function directoryBindLabel(directoryValues, t) {
  if (directoryValues.bindMode === 'service') {
    return t(`${K}.bindOfDirectoryService`, 'Service account {{dn}}', {
      dn: directoryValues.bindDn || '—'
    });
  }
  if (directoryValues.bindMode !== 'anonymous' && directoryValues.authProvider) {
    return t(`${K}.bindOfDirectoryProvider`, "The sign-in provider's bind account");
  }
  return t(`${K}.bindOfDirectoryAnonymous`, 'Anonymous');
}

/**
 * The dedicated editor of an **LDAP browser** installation
 * (`com.intrafind/ldap-browser`): the admin tool that reads raw entries.
 *
 * Restored from the "LDAP browser" section of the former directory editor
 * (`components/people-directories/BrowseSection.jsx` before commit e53c041),
 * now an integration of its own that names a People directory (LDAP)
 * installation and reuses its connection:
 *
 * - **Directory:** the picker of the directory installations, with what the
 *   browser takes over from the chosen one (URL or sign-in provider, base DN,
 *   bind account, transport) and a link to its page.
 * - **Browse settings:** the browse base, the result limit, the account for
 *   browsing (the directory's, anonymous, or one of its own whose password is
 *   a credential) and further attributes to withhold.
 * - **Who may use it:** the groups that grant the installation
 *   (`permissions.integrations`) — `browse.groups` is gone — plus the fixed
 *   rule that only signed-in, non-delegated users browse.
 * - The actions, and the connection test (bind with the browser's account and
 *   a look at the browse base).
 *
 * Registered in `editors/index.js`; the props are the editor contract.
 *
 * @param {Object} props
 * @param {Object} props.instance - the installation with its effective `values` and `liveActions`
 * @param {Object} props.definition - the definition detail (install fields, actions)
 * @param {(saved: Object) => void} props.onSaved
 * @param {() => void} props.onCancel
 */
function LdapBrowserEditor({ instance, definition, onSaved, onCancel }) {
  const { t } = useTranslation();
  const editor = useInstallationEditor({ instance, definition, onSaved });
  const [form, setForm] = useState(() => browserValuesToForm(instance.values || {}));
  const [directories, setDirectories] = useState(null);
  const [limit, setLimit] = useState(BROWSE_MAX_RESULTS_LIMIT);
  const [problems, setProblems] = useState([]);
  const problemsRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    fetchInstalledIntegrations()
      .then(result => {
        if (cancelled) return;
        setDirectories(
          (result.items || []).filter(item => item.definition === LDAP_DIRECTORY_DEFINITION_ID)
        );
      })
      .catch(() => {
        if (!cancelled) setDirectories([]);
      });
    fetchPeopleDirectoryEditorContext()
      .then(result => {
        const max = result?.browse?.limits?.maxResults;
        if (!cancelled && typeof max === 'number') setLimit(max);
      })
      .catch(() => {
        // The built-in upper bound stays.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (problems.length > 0) problemsRef.current?.focus();
  }, [problems]);

  const update = patch => setForm(prev => ({ ...prev, ...patch }));
  const directory = (directories || []).find(item => item.id === form.directory) || null;
  const directoryValues = directory?.values || {};
  const transport = directory?.liveStatus?.transport || 'unknown';

  const fieldErrors = useMemo(() => {
    const out = { ...editor.fieldErrors };
    for (const entry of problems) if (entry.field) out[entry.field] = entry.message;
    return out;
  }, [editor.fieldErrors, problems]);

  const submit = event => {
    event.preventDefault();
    const found = validateBrowserForm(form, { maxResultsLimit: limit });
    if (found.length > 0) {
      setProblems(
        found.map(entry => ({
          field: entry.field,
          fieldId: INPUT_IDS[entry.field] || null,
          message: t(entry.message.key, entry.message.defaultValue, entry.message.values)
        }))
      );
      return;
    }
    setProblems([]);
    void editor.save(browserFormToValues(form));
  };

  const directoryBind = directoryBindLabel(directoryValues, t);

  const bindOptions = [
    {
      value: 'directory',
      label: t(`${K}.bindDirectory`, "The directory's account"),
      help: t(
        `${K}.bindDirectoryHelp`,
        'The account the directory searches with. The browser can read everything it can read.'
      )
    },
    {
      value: 'anonymous',
      label: t(`${K}.bindAnonymous`, 'Anonymous'),
      help: t(`${K}.bindAnonymousHelp`, 'Only what the directory shows to anonymous clients.')
    },
    {
      value: 'service',
      label: t(`${K}.bindService`, 'An account of its own'),
      help: t(
        `${K}.bindServiceHelp`,
        'A read-only account with exactly the reach admins should have.'
      )
    }
  ];

  return (
    <div className="space-y-5" data-testid="ldap-browser-editor">
      <form id={FORM_ID} onSubmit={submit} className="space-y-5" noValidate>
        <div ref={problemsRef} tabIndex={-1} className="focus:outline-hidden">
          <AdminFormErrorSummary
            errors={problems}
            title={t(`${K}.errorsTitle`, 'Please check these fields')}
          />
        </div>

        <NameSection editor={editor} definition={definition} idPrefix="ldap-browser" />

        <EditorSection
          id="lb-directory-section"
          title={t(`${K}.directorySection`, 'People directory')}
          description={t(
            `${K}.directorySectionHelp`,
            'The browser uses the connection of a People directory (LDAP) installation: its URL, TLS settings, trusted certificates, allowed hosts, base DN and, unless you give the browser an account of its own, its bind account.'
          )}
        >
          <div>
            <label htmlFor="lb-directory" className={LABEL_CLASS}>
              {t(`${K}.directory`, 'Directory')}
              <span className="text-red-700 dark:text-red-400 ml-0.5" aria-hidden="true">
                *
              </span>
            </label>
            <select
              id="lb-directory"
              value={form.directory}
              onChange={e => update({ directory: e.target.value })}
              className={INPUT_CLASS}
              aria-invalid={fieldErrors.directory ? 'true' : undefined}
              required
            >
              <option value="">{t(`${K}.directoryPlaceholder`, 'Choose a directory…')}</option>
              {form.directory && directories && !directory && (
                <option value={form.directory}>
                  {t(`${K}.directoryMissing`, '{{id}} (not installed)', { id: form.directory })}
                </option>
              )}
              {(directories || []).map(item => (
                <option key={item.id} value={item.id}>
                  {item.label && item.label !== item.id ? `${item.label} (${item.id})` : item.id}
                </option>
              ))}
            </select>
            <FieldError message={fieldErrors.directory} />
            {directories?.length === 0 && (
              <p className={HELP_CLASS}>
                {t(
                  `${K}.noDirectories`,
                  'No People directory (LDAP) is installed. Install one under Integrations first.'
                )}
              </p>
            )}
          </div>

          {form.directory && directories && !directory && (
            <div className={CALLOUT_CLASS.danger} role="note">
              {t(
                `${K}.directoryMissingHint`,
                'The directory "{{id}}" is not installed: the browser offers no tools. Choose another one.',
                { id: form.directory }
              )}
            </div>
          )}

          {directory && (
            <>
              <dl
                className="grid grid-cols-1 gap-x-4 gap-y-2 rounded-md bg-gray-50 dark:bg-gray-900/40 p-3 text-sm sm:grid-cols-3"
                data-testid="lb-directory-facts"
              >
                {directoryValues.authProvider ? (
                  <Fact label={t(`${K}.signInProvider`, 'Sign-in provider')}>
                    {directoryValues.authProvider}
                  </Fact>
                ) : (
                  <Fact label={t(`${K}.url`, 'URL')} mono>
                    {directoryValues.url || '—'}
                  </Fact>
                )}
                <Fact label={t(`${K}.baseDnOfDirectory`, 'Base DN')} mono>
                  {directoryValues.baseDn || '—'}
                </Fact>
                <Fact label={t(`${K}.bindOfDirectory`, 'Bind account')}>{directoryBind}</Fact>
                <Fact label={t(`${K}.transport`, 'Transport')}>
                  <TransportBadge transport={transport} />
                </Fact>
              </dl>
              {directory.enabled === false && (
                <div className={CALLOUT_CLASS.warning} role="note">
                  {t(
                    `${K}.directoryDisabled`,
                    'This directory is disabled. The browser offers its tools only while the directory is enabled.'
                  )}
                </div>
              )}
              <p className="text-sm">
                <Link
                  to={`/admin/integrations/${encodeURIComponent(directory.id)}`}
                  className="text-indigo-700 dark:text-indigo-300 hover:underline"
                >
                  {t(`${K}.openDirectory`, 'Open the directory')}
                </Link>
              </p>
            </>
          )}
        </EditorSection>

        <EditorSection
          id="lb-settings"
          title={t(`${K}.settingsSection`, 'Browse settings')}
          description={t(
            `${K}.settingsSectionHelp`,
            'Lets admins ask about the directory in plain words and see the raw entries: attributes, branches, group members. Separate from people search, which only returns mapped fields.'
          )}
        >
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label htmlFor="lb-base-dn" className={LABEL_CLASS}>
                {t(`${K}.base`, 'Browse base')}
              </label>
              <input
                id="lb-base-dn"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={form.baseDn}
                onChange={e => update({ baseDn: e.target.value })}
                placeholder={directoryValues.baseDn || 'dc=example,dc=org'}
                aria-describedby="lb-base-dn-help"
                className={MONO_INPUT_CLASS}
              />
              <p id="lb-base-dn-help" className={HELP_CLASS}>
                {t(
                  `${K}.baseHelp`,
                  "Every DN the browser reads must lie here. Leave empty for the directory's base DN, the whole directory; set a branch to limit what admins can see."
                )}
              </p>
              <FieldError message={fieldErrors.baseDn} />
            </div>
            <div>
              <label htmlFor="lb-max-results" className={LABEL_CLASS}>
                {t(`${K}.maxResults`, 'Maximum entries per search')}
              </label>
              <input
                id="lb-max-results"
                type="number"
                inputMode="numeric"
                min={1}
                max={limit}
                value={form.maxResults}
                onChange={e => update({ maxResults: e.target.value })}
                placeholder={String(BROWSE_MAX_RESULTS_DEFAULT)}
                aria-describedby="lb-max-results-help"
                aria-invalid={fieldErrors.maxResults ? 'true' : undefined}
                className={INPUT_CLASS}
              />
              <p id="lb-max-results-help" className={HELP_CLASS}>
                {t(`${K}.maxResultsHelp`, '1 to {{max}}; empty for {{default}}.', {
                  max: limit,
                  default: BROWSE_MAX_RESULTS_DEFAULT
                })}
              </p>
              <FieldError message={fieldErrors.maxResults} />
            </div>
          </div>

          <fieldset>
            <legend className={LABEL_CLASS}>{t(`${K}.bind`, 'Account for browsing')}</legend>
            <div className="space-y-3">
              {bindOptions.map(option => (
                <ChoiceField
                  key={option.value}
                  id={`lb-bind-mode-${option.value}`}
                  name="lb-bind-mode"
                  value={option.value}
                  checked={form.bindMode === option.value}
                  onChange={() => update({ bindMode: option.value })}
                  label={option.label}
                  help={option.help}
                />
              ))}
            </div>
          </fieldset>

          {form.bindMode === 'directory' && (
            <div className={CALLOUT_CLASS.warning} role="note">
              {t(
                `${K}.bindDirectoryWarning`,
                "With the directory's account, the browser has the full reach of the people search account. Use an account of its own if that account can read more than admins should see."
              )}
            </div>
          )}

          {form.bindMode === 'service' && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label htmlFor="lb-bind-dn" className={LABEL_CLASS}>
                  {t(`${K}.bindDn`, 'Bind DN')}
                </label>
                <input
                  id="lb-bind-dn"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={form.bindDn}
                  onChange={e => update({ bindDn: e.target.value })}
                  placeholder="cn=ldap-reader,ou=services,dc=example,dc=org"
                  aria-invalid={fieldErrors.bindDn ? 'true' : undefined}
                  className={MONO_INPUT_CLASS}
                />
                <FieldError message={fieldErrors.bindDn} />
              </div>
              <div>
                <CredentialRefSelect
                  id="lb-bind-password-ref"
                  value={form.bindPasswordRef}
                  onChange={passwordRef => update({ bindPasswordRef: passwordRef })}
                  types={['secret']}
                  label={t(`${K}.password`, 'Password')}
                  help={t(
                    `${K}.passwordHelp`,
                    'Choose the stored credential that holds the password.'
                  )}
                />
                <FieldError message={fieldErrors.bindPasswordRef} />
              </div>
              {transport === 'plaintext' && (
                <div className={`${CALLOUT_CLASS.danger} md:col-span-2`} role="note">
                  {t(
                    `${K}.servicePlaintext`,
                    'A service account never binds over plain text. Use ldaps:// or StartTLS on the directory, or the browser cannot connect.'
                  )}
                </div>
              )}
            </div>
          )}

          <div>
            <label htmlFor="lb-deny-attributes" className={LABEL_CLASS}>
              {t(`${K}.denyAttributes`, 'Further attributes to withhold')}
            </label>
            <textarea
              id="lb-deny-attributes"
              rows={2}
              spellCheck={false}
              value={form.denyAttributes}
              onChange={e => update({ denyAttributes: e.target.value })}
              placeholder="info"
              aria-describedby="lb-deny-attributes-help"
              aria-invalid={fieldErrors.denyAttributes ? 'true' : undefined}
              className={MONO_INPUT_CLASS}
            />
            <p id="lb-deny-attributes-help" className={HELP_CLASS}>
              {t(
                `${K}.denyAttributesHelp`,
                'One attribute name per line. Passwords, LAPS and BitLocker secrets, certificates and photos are always withheld; add attributes where your directory keeps other secrets. Withheld attributes cannot be used in a filter either.'
              )}
            </p>
            <FieldError message={fieldErrors.denyAttributes} />
          </div>

          <p className="text-xs text-gray-600 dark:text-gray-400" data-testid="lb-tool-ids">
            {t(`${K}.toolIds`, 'Tools:')}{' '}
            {browseToolIdsFor(instance.id).map((toolId, index) => (
              <span key={toolId}>
                {index > 0 && ', '}
                <code className="font-mono text-gray-800 dark:text-gray-200">{toolId}</code>
              </span>
            ))}
          </p>
          <p className={CALLOUT_CLASS.info}>
            {t(
              `${K}.auditNote`,
              'Every browser call is written to the audit log with the filter used, never the values returned. The browser is never offered over the MCP gateway. The LDAP browser app ships disabled: enable it under Apps and give it only to admin groups.'
            )}
          </p>
        </EditorSection>

        <AccessSection editor={editor} idPrefix="ldap-browser" />
        <p className={`${HELP_CLASS} -mt-3`}>
          {t(
            `${K}.accessNote`,
            'Only signed-in users browse. Personal API keys, OAuth clients and agents never do, whatever their groups. Raw entries are not for everyone: grant this browser to admin groups only, not with "*".'
          )}
        </p>
        <ActionsSection
          editor={editor}
          definition={definition}
          instance={instance}
          idPrefix="ldap-browser"
        />
      </form>

      <EditorFooter
        editor={editor}
        formId={FORM_ID}
        onTest={() => editor.runTest(browserFormToValues(form))}
        onCancel={onCancel}
        testTitle={t(`${K}.testResults`, 'LDAP browser connection test')}
        testHelp={t(
          `${K}.testHelp`,
          "Checks the directory it reuses, the address, the connection, StartTLS and the bind with the browser's account, and lists the entries directly under the browse base, with the values above (unsaved)."
        )}
      />
    </div>
  );
}

export default LdapBrowserEditor;
