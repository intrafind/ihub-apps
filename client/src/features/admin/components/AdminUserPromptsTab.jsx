import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import Modal from '../../../shared/components/Modal';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { deleteUserPrompt } from '../../../api';
import { fetchAdminGroups, getAdminApiErrorMessage, makeAdminApiCall } from '../../../api/adminApi';
import PromptEditorModal from '../../prompts/components/PromptEditorModal';
import PromptShareDialog from '../../prompts/components/PromptShareDialog';
import PromptVersionsModal from '../../prompts/components/PromptVersionsModal';
import { promptErrorMessage } from '../../prompts/utils/promptErrors';
import { highlightVariables } from '../../../utils/highlightVariables';
import { DataTable, SearchInput } from './data-table';

const inputClass =
  'block w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 text-sm px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500';

/** A global prompt id derived from a name — the server applies the same rule. */
const slugify = name =>
  String(name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'prompt';

function ShareSummary({ prompt }) {
  const { t } = useTranslation();
  const shares = prompt.shares || [];
  const everyone = shares.some(share => share.type === 'everyone');
  const groups = shares.filter(share => share.type === 'group');
  const users = shares.filter(share => share.type === 'user');
  return (
    <div className="flex flex-wrap gap-1">
      {everyone && (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-sky-100 dark:bg-sky-900/50 text-sky-800 dark:text-sky-300">
          <Icon name="globe" size="sm" className="w-3 h-3" />
          {t('admin.prompts.userPrompts.everyone', 'Everyone')}
        </span>
      )}
      {groups.map(group => (
        <span
          key={group.id}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-purple-100 dark:bg-purple-900/50 text-purple-800 dark:text-purple-300"
        >
          <Icon name="user-group" size="sm" className="w-3 h-3" />
          {group.name || group.id}
        </span>
      ))}
      {users.length > 0 && (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300">
          <Icon name="user" size="sm" className="w-3 h-3" />
          {t('admin.prompts.userPrompts.userCount', {
            defaultValue: '{{count}} user(s)',
            count: users.length
          })}
        </span>
      )}
    </div>
  );
}

function PromoteDialog({ prompt, onClose, onPromoted }) {
  const { t } = useTranslation();
  const [id, setId] = useState(() => slugify(prompt.name));
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const idRef = useRef(null);

  const promote = async event => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const response = await makeAdminApiCall(
        `/admin/prompts/${encodeURIComponent(prompt.id)}/promote`,
        { method: 'POST', body: { id: id.trim() || undefined, enabled } }
      );
      onPromoted(response.data?.prompt);
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
      setSaving(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} initialFocusRef={idRef}>
      <form onSubmit={promote}>
        <div className="p-5 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t('admin.prompts.userPrompts.promoteTitle', 'Promote to global prompt')}
          </h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
            {t(
              'admin.prompts.userPrompts.promoteHelp',
              'A copy becomes a global prompt, kept in contents/prompts and credited to its author. Who sees it is decided by the prompts permission of each group, like every other global prompt. The user prompt itself stays as it is.'
            )}
          </p>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label
              htmlFor="promote-id"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              {t('admin.prompts.userPrompts.promoteId', 'Global prompt ID')}
            </label>
            <input
              id="promote-id"
              ref={idRef}
              className={inputClass}
              value={id}
              onChange={e => setId(e.target.value.toLowerCase())}
              maxLength={100}
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-gray-300 text-indigo-600"
              checked={enabled}
              onChange={e => setEnabled(e.target.checked)}
            />
            {t('admin.prompts.userPrompts.promoteEnabled', 'Enable it right away')}
          </label>
          {error && (
            <p className="text-sm text-red-600 dark:text-red-400" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 p-4 border-t border-gray-200 dark:border-gray-700">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {t('admin.prompts.userPrompts.promote', 'Promote')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function PreviewDialog({ prompt, onClose }) {
  const { t } = useTranslation();
  return (
    <Modal isOpen onClose={onClose} maxWidthClassName="max-w-2xl">
      <div className="p-5 border-b border-gray-200 dark:border-gray-700 flex justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 truncate">
            {prompt.name}
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t('admin.prompts.userPrompts.ownedBy', {
              defaultValue: 'Owned by {{name}}',
              name: prompt.owner?.name || prompt.owner?.id || '—'
            })}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close', 'Close')}
          className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
        >
          <Icon name="x" />
        </button>
      </div>
      <div className="p-5 overflow-y-auto space-y-3">
        {prompt.description && (
          <p className="text-sm text-gray-700 dark:text-gray-300">{prompt.description}</p>
        )}
        <pre className="bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-md p-3 text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap wrap-break-word">
          {highlightVariables(prompt.prompt)}
        </pre>
        <ShareSummary prompt={prompt} />
      </div>
    </Modal>
  );
}

/**
 * The settings for user prompts: whether users may keep their own, the
 * per-user limit, how many revisions are kept, and whom prompts may be shared
 * with. Full admins only — a content admin sees the list but not this form.
 */
function UserPromptSettingsPanel() {
  const { t } = useTranslation();
  const [state, setState] = useState(null);
  const [draft, setDraft] = useState(null);
  const [groups, setGroups] = useState([]);
  const [forbidden, setForbidden] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let active = true;
    makeAdminApiCall('/admin/prompts/user-settings')
      .then(response => {
        if (!active) return;
        setState(response.data);
        setDraft(response.data.settings);
      })
      .catch(err => {
        if (!active) return;
        if (err?.response?.status === 403 || err?.response?.status === 401) setForbidden(true);
        else setError(getAdminApiErrorMessage(err));
      });
    fetchAdminGroups()
      .then(data => {
        if (active) setGroups(Object.keys(data?.groups || {}).filter(id => id !== 'anonymous'));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  if (forbidden) return null;
  if (!draft) {
    return error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null;
  }

  const update = patch => {
    setDraft(prev => ({ ...prev, ...patch }));
    setSaved(false);
  };
  const updateSharing = patch => {
    setDraft(prev => ({ ...prev, sharing: { ...prev.sharing, ...patch } }));
    setSaved(false);
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(state.settings);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const response = await makeAdminApiCall('/admin/prompts/user-settings', {
        method: 'PUT',
        body: draft
      });
      setState(response.data);
      setDraft(response.data.settings);
      setSaved(true);
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const toggle = (label, checked, onChange, help) => (
    <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 rounded border-gray-300 text-indigo-600"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
      />
      <span>
        {label}
        {help && <span className="block text-xs text-gray-500 dark:text-gray-400">{help}</span>}
      </span>
    </label>
  );

  return (
    <details className="mt-6 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">
        {t('admin.prompts.userPrompts.settingsTitle', 'Settings for user prompts')}
      </summary>
      <div className="px-4 pb-4 space-y-4">
        {!state.storageAvailable && (
          <p className="text-sm text-amber-700 dark:text-amber-300">
            {t(
              'admin.prompts.userPrompts.storageDown',
              'The storage provider is not available, so users cannot keep prompts right now.'
            )}
          </p>
        )}
        {toggle(
          t('admin.prompts.userPrompts.enabled', 'Users may create their own prompts'),
          draft.enabled,
          value => update({ enabled: value })
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label
              htmlFor="user-prompts-max"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              {t('admin.prompts.userPrompts.maxPerUser', 'Prompts per user (0 = no limit)')}
            </label>
            <input
              id="user-prompts-max"
              type="number"
              min={0}
              className={inputClass}
              value={draft.maxPromptsPerUser}
              onChange={e =>
                update({ maxPromptsPerUser: Math.max(0, Number(e.target.value) || 0) })
              }
            />
          </div>
          <div>
            <label
              htmlFor="user-prompts-versions"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              {t('admin.prompts.userPrompts.maxVersions', 'Versions kept per prompt')}
            </label>
            <input
              id="user-prompts-versions"
              type="number"
              min={1}
              className={inputClass}
              value={draft.maxVersions}
              onChange={e => update({ maxVersions: Math.max(1, Number(e.target.value) || 1) })}
            />
          </div>
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {t('admin.prompts.userPrompts.sharingTitle', 'Users may share prompts with')}
          </legend>
          {toggle(
            t('admin.prompts.userPrompts.allowUsers', 'Specific users'),
            draft.sharing.allowUsers,
            value => updateSharing({ allowUsers: value })
          )}
          {toggle(
            t('admin.prompts.userPrompts.allowGroups', 'Groups'),
            draft.sharing.allowGroups,
            value => updateSharing({ allowGroups: value })
          )}
          {toggle(
            t('admin.prompts.userPrompts.allowEveryone', 'Everyone signed in'),
            draft.sharing.allowEveryone,
            value => updateSharing({ allowEveryone: value })
          )}
        </fieldset>
        {groups.length > 0 && (
          <fieldset>
            <legend className="text-sm font-medium text-gray-700 dark:text-gray-300">
              {t(
                'admin.prompts.userPrompts.restrictTitle',
                'Only members of these groups may share with groups or everyone'
              )}
            </legend>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
              {t(
                'admin.prompts.userPrompts.restrictHelp',
                'Leave all unchecked to let everyone share widely. Sharing with specific users is not affected.'
              )}
            </p>
            <div className="flex flex-wrap gap-3">
              {groups.map(group => (
                <label
                  key={group}
                  className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300"
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-gray-300 text-indigo-600"
                    checked={draft.sharing.restrictToGroups.includes(group)}
                    onChange={e =>
                      updateSharing({
                        restrictToGroups: e.target.checked
                          ? [...draft.sharing.restrictToGroups, group]
                          : draft.sharing.restrictToGroups.filter(g => g !== group)
                      })
                    }
                  />
                  {group}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {error && (
          <p className="text-sm text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-3">
          {saved && !dirty && (
            <span className="text-sm text-green-600 dark:text-green-400">
              {t('admin.prompts.userPrompts.saved', 'Saved')}
            </span>
          )}
          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving}
            className="px-4 py-2 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {t('common.save', 'Save')}
          </button>
        </div>
      </div>
    </details>
  );
}

/**
 * Admin → Prompts → User prompts: the prompts users shared with groups or with
 * everyone, which admins may edit, re-share, delete or promote to a global
 * prompt. Every change is audit-logged by the server.
 */
function AdminUserPromptsTab() {
  const { t, i18n } = useTranslation();
  const [prompts, setPrompts] = useState([]);
  const [truncated, setTruncated] = useState(false);
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState(null);
  const [preview, setPreview] = useState(null);
  const [editing, setEditing] = useState(null);
  const [sharing, setSharing] = useState(null);
  const [history, setHistory] = useState(null);
  const [promoting, setPromoting] = useState(null);
  const [deleting, setDeleting] = useState(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await makeAdminApiCall('/admin/prompts?scope=user');
      setPrompts(Array.isArray(response.data?.prompts) ? response.data.prompts : []);
      setTruncated(response.data?.truncated === true);
      setAvailable(response.data?.available !== false);
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return prompts;
    return prompts.filter(prompt =>
      [prompt.name, prompt.description, prompt.prompt, prompt.owner?.name, prompt.owner?.id].some(
        value => typeof value === 'string' && value.toLowerCase().includes(term)
      )
    );
  }, [prompts, search]);

  const done = text => {
    setNotice(text);
    load();
  };

  const confirmDelete = async () => {
    const prompt = deleting;
    setDeleting(null);
    try {
      await deleteUserPrompt(prompt.id);
      done(t('admin.prompts.userPrompts.deleted', 'Prompt deleted'));
    } catch (err) {
      setError(promptErrorMessage(err, t));
    }
  };

  const formatDate = value => (value ? new Date(value).toLocaleString(i18n.language) : '—');

  const columns = [
    {
      key: 'name',
      header: t('admin.prompts.table.name', 'Name'),
      sortable: true,
      sortAccessor: prompt => prompt.name,
      render: prompt => (
        <div className="flex items-center min-w-0">
          <div className="shrink-0 h-8 w-8 rounded-full bg-emerald-100 dark:bg-emerald-900/50 flex items-center justify-center">
            <Icon
              name={prompt.icon || 'clipboard'}
              className="h-4 w-4 text-emerald-700 dark:text-emerald-300"
            />
          </div>
          <div className="ml-3 min-w-0">
            <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
              {prompt.name}
            </div>
            {prompt.promotedTo?.promptId && (
              <div className="text-xs text-indigo-600 dark:text-indigo-400">
                {t('admin.prompts.userPrompts.promotedTo', {
                  defaultValue: 'Promoted to {{id}}',
                  id: prompt.promotedTo.promptId
                })}
              </div>
            )}
          </div>
        </div>
      )
    },
    {
      key: 'owner',
      header: t('admin.prompts.userPrompts.owner', 'Owner'),
      sortable: true,
      sortAccessor: prompt => prompt.owner?.name || '',
      render: prompt => (
        <div className="text-sm text-gray-700 dark:text-gray-300">
          {prompt.owner?.name || prompt.owner?.id}
          {prompt.owner?.active === false && (
            <span className="ml-2 px-1.5 py-0.5 rounded-full text-xs bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-300">
              {t('admin.prompts.userPrompts.inactive', 'inactive')}
            </span>
          )}
        </div>
      )
    },
    {
      key: 'shared',
      header: t('admin.prompts.userPrompts.sharedWith', 'Shared with'),
      hideBelow: 'md',
      render: prompt => <ShareSummary prompt={prompt} />
    },
    {
      key: 'updated',
      header: t('admin.prompts.userPrompts.updated', 'Last changed'),
      sortable: true,
      sortAccessor: prompt => prompt.updatedAt || '',
      hideBelow: 'lg',
      render: prompt => (
        <div className="text-xs text-gray-500 dark:text-gray-400">
          {formatDate(prompt.updatedAt)}
          {prompt.updatedBy ? ` · ${prompt.updatedBy}` : ''}
        </div>
      )
    }
  ];

  const actions = [
    {
      id: 'edit',
      label: t('admin.prompts.edit', 'Edit'),
      icon: 'pencil',
      priority: 'primary',
      onClick: prompt => setEditing(prompt)
    },
    {
      id: 'promote',
      label: t('admin.prompts.userPrompts.promote', 'Promote'),
      icon: 'arrow-up',
      priority: 'primary',
      onClick: prompt => setPromoting(prompt)
    },
    {
      id: 'share',
      label: t('prompts.actions.share', 'Share'),
      icon: 'users',
      onClick: prompt => setSharing(prompt)
    },
    {
      id: 'history',
      label: t('prompts.actions.history', 'History'),
      icon: 'clock',
      onClick: prompt => setHistory(prompt)
    },
    {
      id: 'delete',
      label: t('admin.prompts.delete', 'Delete'),
      icon: 'trash',
      destructive: true,
      onClick: prompt => setDeleting(prompt)
    }
  ];

  return (
    <div className="mt-6">
      <p className="text-sm text-gray-600 dark:text-gray-300">
        {t(
          'admin.prompts.userPrompts.intro',
          'Prompts users have shared with a group or with everyone. You can edit, re-share, delete or promote them to a global prompt; private prompts and prompts shared with named users only are not listed.'
        )}
      </p>
      <UserPromptSettingsPanel />

      {!available && (
        <p className="mt-4 text-sm text-amber-700 dark:text-amber-300">
          {t(
            'admin.prompts.userPrompts.storageDown',
            'The storage provider is not available, so users cannot keep prompts right now.'
          )}
        </p>
      )}
      {notice && (
        <div
          role="status"
          className="mt-4 flex items-center justify-between rounded-md bg-green-50 dark:bg-green-900/30 px-4 py-2 text-sm text-green-700 dark:text-green-300"
        >
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label={t('common.close', 'Close')}
          >
            <Icon name="x" size="sm" />
          </button>
        </div>
      )}
      {error && (
        <p className="mt-4 text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder={t('admin.prompts.searchPlaceholder', 'Search prompts...')}
        />
        {truncated && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {t('admin.prompts.userPrompts.truncated', 'Showing the first prompts only')}
          </span>
        )}
      </div>

      <div className="mt-4">
        <DataTable
          columns={columns}
          data={filtered}
          getRowId={prompt => prompt.id}
          actions={actions}
          loading={loading}
          onRowClick={prompt => setPreview(prompt)}
          empty={{
            icon: 'users',
            title: t('admin.prompts.userPrompts.empty', 'No shared user prompts'),
            description: t(
              'admin.prompts.userPrompts.emptyDesc',
              'When users share prompts with a group or with everyone, they show up here.'
            )
          }}
        />
      </div>

      {preview && <PreviewDialog prompt={preview} onClose={() => setPreview(null)} />}
      {editing && (
        <PromptEditorModal
          prompt={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            done(t('prompts.notices.saved', 'Prompt saved'));
          }}
        />
      )}
      {sharing && (
        <PromptShareDialog
          prompt={sharing}
          onClose={() => setSharing(null)}
          onSaved={() => {
            setSharing(null);
            done(t('prompts.notices.shared', 'Sharing updated'));
          }}
        />
      )}
      {history && (
        <PromptVersionsModal
          prompt={history}
          canRestore
          onClose={() => setHistory(null)}
          onRestored={() => {
            setHistory(null);
            done(t('prompts.notices.restored', 'Version restored'));
          }}
        />
      )}
      {promoting && (
        <PromoteDialog
          prompt={promoting}
          onClose={() => setPromoting(null)}
          onPromoted={globalPrompt => {
            setPromoting(null);
            done(
              t('admin.prompts.userPrompts.promoted', {
                defaultValue: 'Promoted to global prompt {{id}}',
                id: globalPrompt?.id || ''
              })
            );
          }}
        />
      )}
      <ConfirmDialog
        isOpen={Boolean(deleting)}
        title={t('prompts.delete.title', 'Delete prompt?')}
        message={t('admin.prompts.userPrompts.deleteMessage', {
          defaultValue:
            '“{{name}}” by {{owner}} will be deleted for its owner and everyone it is shared with.',
          name: deleting?.name || '',
          owner: deleting?.owner?.name || deleting?.owner?.id || ''
        })}
        confirmLabel={t('common.delete', 'Delete')}
        denyLabel={t('common.cancel', 'Cancel')}
        danger
        onConfirm={confirmDelete}
        onDeny={() => setDeleting(null)}
      />
    </div>
  );
}

export default AdminUserPromptsTab;
