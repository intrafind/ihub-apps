// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { getLocalizedContent } from '../../../utils/localizeContent';
import AdminBreadcrumb from '../components/AdminBreadcrumb';
import AdminFormErrorSummary from '../components/AdminFormErrorSummary';
import AdminLoadError from '../components/AdminLoadError';
import AdminPageSkeleton from '../components/AdminPageSkeleton';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import FormSection from '../components/people-directories/FormSection';
import ChoiceField from '../components/people-directories/ChoiceField';
import SourceSection from '../components/people-directories/SourceSection';
import AccessSection from '../components/people-directories/AccessSection';
import NetworkSection from '../components/people-directories/NetworkSection';
import VisibilitySection from '../components/people-directories/VisibilitySection';
import ModelFacingSection from '../components/people-directories/ModelFacingSection';
import LimitsSection from '../components/people-directories/LimitsSection';
import MappingSection from '../components/people-directories/MappingSection';
import DirectoryTestPanel from '../components/people-directories/DirectoryTestPanel';
import {
  CALLOUT_CLASS,
  HELP_CLASS,
  LABEL_CLASS,
  MONO_INPUT_CLASS,
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS
} from '../components/people-directories/formStyles';
import {
  fetchPeopleDirectories,
  fetchPeopleDirectoryPresets,
  savePeopleDirectories
} from '../../../api/peopleDirectoriesAdminApi';
import { fetchAdminGroups, getAdminApiErrorMessage } from '../../../api/adminApi';
import {
  DEFAULT_PERSON_FIELDS,
  createDirectoryForm,
  describeSaveError,
  directoryToForm,
  effectivePresetId,
  formToDirectory,
  inputIdForField,
  splitSaveIssues,
  transportOf,
  validateDirectoryForm,
  withDirectory
} from '../utils/peopleDirectories';

const LIST_PATH = '/admin/integrations/people-directories';
const FORM_ID = 'pd-editor';

/**
 * Admin → Integrations → People directories → one directory
 * (`/admin/integrations/people-directories/:directoryId`, `new` to create).
 *
 * A new entry can be prefilled from the query string —
 * `?authProvider=<sign-in provider>&name=<display name>` — which is what the
 * "Use for people search" action on an LDAP sign-in provider opens.
 *
 * The page edits one entry of `peopleDirectories.json` in sections (Source,
 * Access, Network, Visibility, Model-facing, Limits, Mapping) and saves by
 * loading the current list, putting the entry in, and writing the whole list
 * back. The test panel between the form and the Save button runs the
 * connection test against the form as it stands.
 */
function AdminPeopleDirectoryEditPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { directoryId } = useParams();
  const [searchParams] = useSearchParams();
  const isNew = directoryId === 'new';

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [data, setData] = useState(null);
  const [presetsData, setPresetsData] = useState(null);
  const [groups, setGroups] = useState([]);
  const [form, setForm] = useState(null);
  const [initialForm, setInitialForm] = useState(null);
  const [errors, setErrors] = useState([]);
  const [saveError, setSaveError] = useState(null);
  const [saving, setSaving] = useState(false);

  const { blocker, markSaved } = useUnsavedChanges(initialForm, form);
  const problemsRef = useRef(null);
  // The stored entry this form's save may replace: the one loaded with the
  // page, or the newer one a "changed elsewhere" warning has shown.
  const baselineRef = useRef(undefined);

  // Save is at the bottom of a long page: bring the list of problems into view
  // and move focus there, so keyboard and screen-reader users land on it too.
  useEffect(() => {
    if (errors.length > 0 || saveError) problemsRef.current?.focus();
  }, [errors, saveError]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setLoadError(null);
      setNotFound(false);
      try {
        const [response, presets] = await Promise.all([
          fetchPeopleDirectories(),
          fetchPeopleDirectoryPresets().catch(() => null)
        ]);
        if (cancelled) return;
        const directories = Array.isArray(response?.directories) ? response.directories : [];
        setData({
          directories,
          effective: response?.effective || {},
          ldapProviders: Array.isArray(response?.ldapProviders) ? response.ldapProviders : []
        });
        setPresetsData(presets);
        let next = null;
        if (isNew) {
          next = createDirectoryForm({
            authProvider: searchParams.get('authProvider') || '',
            name: searchParams.get('name') || '',
            existingIds: directories.map(d => d.id)
          });
        } else {
          const directory = directories.find(d => d.id === directoryId);
          if (directory) next = directoryToForm(directory);
          else setNotFound(true);
        }
        setForm(next);
        setInitialForm(next);
      } catch (err) {
        if (!cancelled) setLoadError(getAdminApiErrorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    fetchAdminGroups()
      .then(response => {
        if (cancelled) return;
        const list = Object.values(response?.groups || {}).map(group => ({
          id: group.id,
          name: getLocalizedContent(group.name, i18n.language) || group.id,
          description: getLocalizedContent(group.description, i18n.language) || ''
        }));
        list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        setGroups(list);
      })
      .catch(() => {
        // Not fatal: the stored groups still show, they only cannot be searched.
      });
    return () => {
      cancelled = true;
    };
    // The query string only prefills a new entry when the page opens.
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, [directoryId]);

  const update = useCallback(patch => setForm(prev => ({ ...prev, ...patch })), []);

  const fieldLabel = field => {
    const [head, tail] = String(field).split('.');
    const labels = {
      id: t('admin.peopleDirectories.form.id', 'ID'),
      enabled: t('admin.peopleDirectories.form.enabled', 'Enabled'),
      authProvider: t('admin.peopleDirectories.source.provider', 'Sign-in provider'),
      url: t('admin.peopleDirectories.source.url', 'URL'),
      starttls: t('admin.peopleDirectories.source.starttls', 'StartTLS'),
      baseDn: t('admin.peopleDirectories.source.baseDn', 'Base DN'),
      preset: t('admin.peopleDirectories.source.preset', 'Directory type'),
      tlsOptions: 'tlsOptions',
      bind:
        tail === 'dn'
          ? t('admin.peopleDirectories.access.bindDn', 'Bind DN')
          : tail === 'passwordRef'
            ? t('admin.peopleDirectories.access.password', 'Password')
            : t('admin.peopleDirectories.access.title', 'Access'),
      searchBase: t('admin.peopleDirectories.mapping.searchBase', 'Search base'),
      personFilter: t('admin.peopleDirectories.mapping.personFilter', 'Person filter'),
      searchAttributes: t(
        'admin.peopleDirectories.mapping.searchAttributes',
        'Free-text attributes'
      ),
      attributeMapping: tail
        ? t(`admin.peopleDirectories.fields.${tail}`, tail)
        : t('admin.peopleDirectories.mapping.title', 'Search and mapping'),
      units: t('admin.peopleDirectories.limits.units', 'Offer organisational units (list_units)'),
      allowPlaintext: t(
        'admin.peopleDirectories.network.allowPlaintext',
        'Allow plain-text connections (ldap:// without StartTLS)'
      ),
      tlsCa: t('admin.peopleDirectories.network.tlsCa', 'Trusted certificates'),
      allowedHosts: t(
        'admin.peopleDirectories.network.allowedHosts',
        'Hosts allowed on private addresses'
      ),
      maxResults: t('admin.peopleDirectories.limits.maxResults', 'Maximum results per search'),
      timeoutMs: t('admin.peopleDirectories.limits.timeoutMs', 'Timeout (ms)'),
      concurrency: t('admin.peopleDirectories.limits.concurrency', 'Parallel requests'),
      requestDelayMs: t(
        'admin.peopleDirectories.limits.requestDelayMs',
        'Delay between requests (ms)'
      ),
      groups: t('admin.peopleDirectories.visibility.groups', 'Groups'),
      dataFlow: t('admin.peopleDirectories.visibility.dataFlow', 'Data flow'),
      name: `${t('admin.peopleDirectories.model.name', 'Name')}${tail ? ` (${tail.toUpperCase()})` : ''}`,
      description: `${t('admin.peopleDirectories.model.descriptionLabel', 'Description')}${
        tail ? ` (${tail.toUpperCase()})` : ''
      }`
    };
    return labels[head] ?? field;
  };

  /** Error summary entries, one per input, in the order the issues came. */
  const toSummary = issues => {
    const seen = new Set();
    return issues.filter(issue => {
      const key = issue.fieldId || `m-${issue.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const handleSave = async event => {
    event.preventDefault();
    setSaveError(null);
    const otherIds = data.directories.filter(d => isNew || d.id !== directoryId).map(d => d.id);
    const problems = validateDirectoryForm(form, {
      isNew,
      otherIds,
      limits: presetsData?.limits
    });
    if (problems.length > 0) {
      setErrors(
        toSummary(
          problems.map(problem => ({
            fieldId: inputIdForField(problem.field),
            label: fieldLabel(problem.field),
            message: t(problem.message.key, problem.message.defaultValue, problem.message.values)
          }))
        )
      );
      return;
    }
    setErrors([]);
    setSaving(true);
    let list = null;
    const directory = formToDirectory(form);
    try {
      // Write onto the current list, so a change made meanwhile to another
      // directory is not undone.
      const current = await fetchPeopleDirectories();
      const directories = Array.isArray(current?.directories) ? current.directories : [];
      if (isNew && directories.some(d => d.id === directory.id)) {
        setErrors([
          {
            fieldId: inputIdForField('id'),
            label: fieldLabel('id'),
            message: t(
              'admin.peopleDirectories.errors.idTaken',
              'Another directory uses "{{id}}".',
              {
                id: directory.id
              }
            )
          }
        ]);
        return;
      }
      const before = isNew ? null : directories.find(d => d.id === directoryId);
      if (!isNew) {
        const baseline =
          baselineRef.current === undefined
            ? (data.directories.find(d => d.id === directoryId) ?? null)
            : baselineRef.current;
        if (JSON.stringify(before ?? null) !== JSON.stringify(baseline)) {
          // Someone else saved this directory meanwhile: say so once; saving
          // again overwrites their change.
          baselineRef.current = before ?? null;
          setSaveError(
            t(
              'admin.peopleDirectories.edit.changedElsewhere',
              'This directory was changed elsewhere after you opened it. Save again to overwrite that change, or reload the page to see it.'
            )
          );
          return;
        }
      }
      list = withDirectory(directories, directory, isNew ? null : directoryId);
      await savePeopleDirectories(list);
      markSaved();
      navigate(LIST_PATH, {
        state: {
          savedId: directory.id,
          justEnabled: directory.enabled && !(before && before.enabled !== false)
        }
      });
    } catch (err) {
      const body = err?.response?.data;
      if (err?.response?.status === 400 && Array.isArray(body?.details) && list) {
        const index = list.findIndex(d => d.id === directory.id);
        const { fields, other } = splitSaveIssues(body.details, index);
        setErrors(
          toSummary([
            ...fields.map(issue => ({
              fieldId: inputIdForField(issue.field),
              label: fieldLabel(issue.field),
              message: issue.message
            })),
            ...other.map(text => ({ message: text }))
          ])
        );
        setSaveError(body.error || getAdminApiErrorMessage(err));
      } else {
        setSaveError(describeSaveError(err));
      }
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <AdminPageSkeleton rows={4} />
      </div>
    );
  }
  if (loadError) {
    return (
      <AdminLoadError
        title={t('admin.peopleDirectories.edit.loadError', 'The directory could not be loaded')}
        message={loadError}
      />
    );
  }
  if (notFound || !form) {
    return (
      <AdminLoadError
        title={t('admin.peopleDirectories.edit.notFoundTitle', 'Directory not found')}
        message={t(
          'admin.peopleDirectories.edit.notFound',
          'There is no people directory "{{id}}".',
          { id: directoryId }
        )}
        action={{
          label: t('admin.peopleDirectories.edit.backToList', 'Back to people directories'),
          onClick: () => navigate(LIST_PATH)
        }}
      />
    );
  }

  const provider =
    form.sourceMode === 'provider'
      ? data.ldapProviders.find(p => p.name === form.authProvider)
      : undefined;
  const transport = transportOf(form, provider);
  const presets = Array.isArray(presetsData?.presets) ? presetsData.presets : [];
  const presetId = effectivePresetId(form, provider);
  const preset = presets.find(p => p.id === presetId);
  const presetLabel = t(`admin.peopleDirectories.presets.${presetId}`, preset?.label || presetId);
  const fields = Array.isArray(presetsData?.fields) ? presetsData.fields : DEFAULT_PERSON_FIELDS;
  const baseDnHint = form.baseDn || provider?.userSearchBase || provider?.baseDn || '';
  const status = !isNew ? data.effective?.[directoryId] : null;
  const title = isNew
    ? t('admin.peopleDirectories.edit.createTitle', 'Add people directory')
    : getLocalizedContent(initialForm?.name, i18n.language) || directoryId;

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <AdminBreadcrumb
        crumbs={[
          { label: t('admin.nav.integrations', 'Integrations'), href: '/admin/integrations' },
          { label: t('admin.peopleDirectories.title', 'People directories'), href: LIST_PATH },
          { label: title }
        ]}
      />
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{title}</h1>
      <p className="mt-1 mb-6 text-sm text-gray-600 dark:text-gray-400">
        {t(
          'admin.peopleDirectories.edit.subtitle',
          'Each enabled directory gives apps read-only tools to search for people and read one person. Nothing is written to the directory.'
        )}
      </p>

      {status && (status.problems?.length > 0 || status.warnings?.length > 0) && (
        <div
          className={`${status.problems?.length ? CALLOUT_CLASS.danger : CALLOUT_CLASS.warning} mb-6`}
          role="note"
        >
          <p className="font-medium">
            {t('admin.peopleDirectories.edit.statusTitle', 'As saved, this directory has issues:')}
          </p>
          <ul className="mt-1 list-disc pl-5">
            {[...(status.problems || []), ...(status.warnings || [])].map(text => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        </div>
      )}

      <form id={FORM_ID} onSubmit={handleSave} noValidate className="space-y-6">
        <div ref={problemsRef} tabIndex={-1} className="space-y-4 focus:outline-hidden">
          <AdminFormErrorSummary
            errors={errors}
            title={t('admin.peopleDirectories.edit.errorsTitle', 'Please check these fields')}
          />
          {saveError && (
            <AdminLoadError
              framed={false}
              action={null}
              title={t('admin.peopleDirectories.edit.saveError', 'The directory was not saved')}
              message={saveError}
            />
          )}
        </div>

        <FormSection id="pd-basics" title={t('admin.peopleDirectories.edit.basics', 'Directory')}>
          <div>
            <label htmlFor="pd-id" className={LABEL_CLASS}>
              {t('admin.peopleDirectories.form.id', 'ID')}
            </label>
            <input
              id="pd-id"
              type="text"
              autoComplete="off"
              spellCheck={false}
              required
              readOnly={!isNew}
              value={form.id}
              onChange={e => update({ id: e.target.value })}
              placeholder="corp"
              aria-describedby="pd-id-help"
              className={`${MONO_INPUT_CLASS} read-only:bg-gray-100 dark:read-only:bg-gray-900`}
            />
            <p id="pd-id-help" className={HELP_CLASS}>
              {isNew
                ? t(
                    'admin.peopleDirectories.form.idHelp',
                    '2 to 32 lower-case letters, digits and "-". It becomes the prefix of the tool ids and cannot be changed later.'
                  )
                : t(
                    'admin.peopleDirectories.form.idFixed',
                    'The id prefixes the tool ids apps select, so it cannot be changed.'
                  )}
            </p>
          </div>
          <ChoiceField
            id="pd-enabled"
            type="checkbox"
            checked={form.enabled}
            onChange={enabled => update({ enabled })}
            label={t('admin.peopleDirectories.form.enabled', 'Enabled')}
            help={t(
              'admin.peopleDirectories.form.enabledHelp',
              'Offer the tools of this directory to apps. While off, no search reaches the directory.'
            )}
          />
        </FormSection>

        <SourceSection
          form={form}
          update={update}
          ldapProviders={data.ldapProviders}
          provider={provider}
          presets={presets}
        />
        <AccessSection form={form} update={update} provider={provider} transport={transport} />
        <NetworkSection form={form} update={update} transport={transport} />
        <VisibilitySection form={form} update={update} availableGroups={groups} />
        <ModelFacingSection form={form} update={update} />
        <LimitsSection
          form={form}
          update={update}
          defaults={presetsData?.defaults}
          limits={presetsData?.limits}
        />
        <MappingSection
          form={form}
          update={update}
          preset={preset}
          presetLabel={presetLabel}
          fields={fields}
          baseDnHint={baseDnHint}
        />
      </form>

      <div className="mt-6">
        <DirectoryTestPanel buildDirectory={() => formToDirectory(form)} fields={fields} />
      </div>

      <div className="mt-6 flex flex-wrap justify-end gap-3">
        <Link to={LIST_PATH} className={SECONDARY_BUTTON_CLASS}>
          {t('common.cancel', 'Cancel')}
        </Link>
        <button type="submit" form={FORM_ID} disabled={saving} className={PRIMARY_BUTTON_CLASS}>
          {saving
            ? t('admin.peopleDirectories.edit.saving', 'Saving…')
            : t('admin.peopleDirectories.edit.save', 'Save directory')}
        </button>
      </div>

      <ConfirmDialog
        isOpen={blocker.state === 'blocked'}
        title={t('admin.peopleDirectories.edit.unsavedTitle', 'Unsaved changes')}
        message={t(
          'admin.peopleDirectories.edit.unsavedMessage',
          'You have unsaved changes. Leave anyway?'
        )}
        confirmLabel={t('admin.peopleDirectories.edit.leave', 'Leave')}
        denyLabel={t('admin.peopleDirectories.edit.stay', 'Stay')}
        onConfirm={() => blocker.proceed?.()}
        onDeny={() => blocker.reset?.()}
      />
    </div>
  );
}

export default AdminPeopleDirectoryEditPage;
