import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import Modal from '../../../shared/components/Modal';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import {
  deleteUserSkill,
  fetchAdminUserSkills,
  fetchUserSkillSettings,
  promoteUserSkill,
  saveUserSkillSettings
} from '../../../api';
import { fetchAdminGroups } from '../../../api/adminApi';
import SkillDetailsModal from '../../skills/components/SkillDetailsModal';
import SkillEditorModal from '../../skills/components/SkillEditorModal';
import SkillShareDialog from '../../skills/components/SkillShareDialog';
import SkillVersionsModal from '../../skills/components/SkillVersionsModal';
import { skillErrorMessage } from '../../skills/utils/skillErrors';
import { skillValidationMessage, validateSkillName } from '../../skills/utils/skillValidation';
import { DataTable, SearchInput } from './data-table';

const inputClass =
  'block w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 text-sm px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500';

/** Settings shown when the server leaves a key out. */
const DEFAULT_SETTINGS = {
  enabled: true,
  maxSkillsPerUser: 50,
  maxVersions: 50,
  maxSkillSizeKB: 256,
  maxFilesPerSkill: 20,
  sharing: { allowUsers: true, allowGroups: true, allowEveryone: true, restrictToGroups: [] }
};

/**
 * The settings as the form edits them: every key present, so a partial
 * answer from the server never breaks the form.
 *
 * @param {Object} settings - Settings from the server.
 * @returns {Object}
 */
function normalizeSettings(settings) {
  const sharing = { ...DEFAULT_SETTINGS.sharing, ...(settings?.sharing || {}) };
  return {
    ...DEFAULT_SETTINGS,
    ...(settings || {}),
    sharing: {
      ...sharing,
      restrictToGroups: Array.isArray(sharing.restrictToGroups) ? sharing.restrictToGroups : []
    }
  };
}

function ShareSummary({ skill }) {
  const { t } = useTranslation();
  const shares = skill.shares || [];
  const everyone = shares.some(share => share.type === 'everyone');
  const groups = shares.filter(share => share.type === 'group');
  const users = shares.filter(share => share.type === 'user');
  return (
    <div className="flex flex-wrap gap-1">
      {everyone && (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-sky-100 dark:bg-sky-900/50 text-sky-800 dark:text-sky-300">
          <Icon name="globe" size="sm" className="w-3 h-3" />
          {t('admin.skills.userSkills.everyone', 'Everyone')}
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
          {t('admin.skills.userSkills.userCount', {
            defaultValue: '{{count}} user(s)',
            count: users.length
          })}
        </span>
      )}
    </div>
  );
}

/**
 * Ask for the name of the global skill a user skill becomes, prefilled with
 * the skill's own name, and promote it.
 */
function PromoteDialog({ skill, onClose, onPromoted }) {
  const { t } = useTranslation();
  const [name, setName] = useState(skill.name || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const nameRef = useRef(null);
  const nameError = skillValidationMessage(validateSkillName(name), t);

  const promote = async event => {
    event.preventDefault();
    if (nameError) return;
    setSaving(true);
    setError(null);
    try {
      const result = await promoteUserSkill(skill.id, { name });
      onPromoted(result);
    } catch (err) {
      setError(skillErrorMessage(err, t));
      setSaving(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} initialFocusRef={nameRef}>
      <form onSubmit={promote} noValidate>
        <div className="p-5 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t('admin.skills.userSkills.promoteTitle', 'Promote to global skill')}
          </h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
            {t(
              'admin.skills.userSkills.promoteHelp',
              'A copy becomes a global skill, kept in contents/skills. Which apps offer it and which groups may use it is configured like for every other global skill. The user skill itself stays as it is.'
            )}
          </p>
        </div>
        <div className="p-5 space-y-2">
          <label
            htmlFor="promote-skill-name"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
          >
            {t('admin.skills.userSkills.promoteName', 'Global skill name')}
          </label>
          <input
            id="promote-skill-name"
            ref={nameRef}
            className={`${inputClass} font-mono`}
            value={name}
            onChange={e => setName(e.target.value)}
            maxLength={64}
            aria-invalid={Boolean(nameError)}
            aria-describedby="promote-skill-name-hint"
            autoComplete="off"
            spellCheck={false}
          />
          <p
            id="promote-skill-name-hint"
            className={`text-xs ${nameError ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}`}
          >
            {nameError ||
              t(
                'admin.skills.userSkills.promoteNameHint',
                'Lowercase letters, digits and hyphens. Must not be taken by another global skill.'
              )}
          </p>
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
            disabled={saving || Boolean(nameError)}
            className="px-4 py-2 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {t('admin.skills.userSkills.promote', 'Promote')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * The settings for personal skills: whether users may keep their own, the
 * per-user limits, how many revisions are kept, and whom skills may be shared
 * with. Full admins only — a content admin sees the list but not this form.
 */
function UserSkillSettingsPanel() {
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
    fetchUserSkillSettings()
      .then(data => {
        if (!active) return;
        const settings = normalizeSettings(data?.settings);
        setState({ settings, storageAvailable: data?.storageAvailable !== false });
        setDraft(settings);
      })
      .catch(err => {
        if (!active) return;
        if (err?.status === 403 || err?.status === 401) setForbidden(true);
        else setError(skillErrorMessage(err, t));
      });
    fetchAdminGroups()
      .then(data => {
        if (active) setGroups(Object.keys(data?.groups || {}).filter(id => id !== 'anonymous'));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [t]);

  if (forbidden) return null;
  if (!draft) {
    return error ? <p className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p> : null;
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
      const data = await saveUserSkillSettings(draft);
      const settings = normalizeSettings(data?.settings || draft);
      setState({ settings, storageAvailable: data?.storageAvailable !== false });
      setDraft(settings);
      setSaved(true);
    } catch (err) {
      setError(skillErrorMessage(err, t));
    } finally {
      setSaving(false);
    }
  };

  const toggle = (label, checked, onChange) => (
    <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 rounded border-gray-300 text-indigo-600"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );

  const numberField = (id, label, key, min) => (
    <div>
      <label
        htmlFor={id}
        className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
      >
        {label}
      </label>
      <input
        id={id}
        type="number"
        min={min}
        className={inputClass}
        value={draft[key]}
        onChange={e => update({ [key]: Math.max(min, Number(e.target.value) || min) })}
      />
    </div>
  );

  return (
    <details className="mt-6 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">
        {t('admin.skills.userSkills.settingsTitle', 'Settings for user skills')}
      </summary>
      <div className="px-4 pb-4 space-y-4">
        {!state.storageAvailable && (
          <p className="text-sm text-amber-700 dark:text-amber-300">
            {t(
              'admin.skills.userSkills.storageDown',
              'The storage provider is not available, so users cannot keep skills right now.'
            )}
          </p>
        )}
        {toggle(
          t('admin.skills.userSkills.enabled', 'Users may create their own skills'),
          draft.enabled,
          value => update({ enabled: value })
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          {numberField(
            'user-skills-max',
            t('admin.skills.userSkills.maxPerUser', 'Skills per user (0 = no limit)'),
            'maxSkillsPerUser',
            0
          )}
          {numberField(
            'user-skills-versions',
            t('admin.skills.userSkills.maxVersions', 'Versions kept per skill'),
            'maxVersions',
            1
          )}
          {numberField(
            'user-skills-size',
            t('admin.skills.userSkills.maxSizeKB', 'Maximum size per skill (KB)'),
            'maxSkillSizeKB',
            1
          )}
          {numberField(
            'user-skills-files',
            t('admin.skills.userSkills.maxFiles', 'Files per skill'),
            'maxFilesPerSkill',
            0
          )}
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {t('admin.skills.userSkills.sharingTitle', 'Users may share skills with')}
          </legend>
          {toggle(
            t('admin.skills.userSkills.allowUsers', 'Specific users'),
            draft.sharing.allowUsers,
            value => updateSharing({ allowUsers: value })
          )}
          {toggle(
            t('admin.skills.userSkills.allowGroups', 'Groups'),
            draft.sharing.allowGroups,
            value => updateSharing({ allowGroups: value })
          )}
          {toggle(
            t('admin.skills.userSkills.allowEveryone', 'Everyone signed in'),
            draft.sharing.allowEveryone,
            value => updateSharing({ allowEveryone: value })
          )}
        </fieldset>
        {groups.length > 0 && (
          <fieldset>
            <legend className="text-sm font-medium text-gray-700 dark:text-gray-300">
              {t(
                'admin.skills.userSkills.restrictTitle',
                'Only members of these groups may share with groups or everyone'
              )}
            </legend>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
              {t(
                'admin.skills.userSkills.restrictHelp',
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
              {t('admin.skills.userSkills.saved', 'Saved')}
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
 * Admin → Skills → User skills: the skills users shared with groups or with
 * everyone, which admins may edit, re-share, delete or promote to a global
 * skill. Edits go through the user skill routes, which grant admins access.
 * Every change is audit-logged by the server.
 *
 * @param {Object} props
 * @param {() => void} [props.onGlobalSkillsChanged] - Called after a promotion
 *   added a global skill, so the global list can reload.
 */
function AdminUserSkillsTab({ onGlobalSkillsChanged }) {
  const { t, i18n } = useTranslation();
  const [skills, setSkills] = useState([]);
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
      const data = await fetchAdminUserSkills();
      setSkills(Array.isArray(data?.skills) ? data.skills : []);
      setTruncated(data?.truncated === true);
      setAvailable(data?.available !== false);
    } catch (err) {
      setError(skillErrorMessage(err, t));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return skills;
    return skills.filter(skill =>
      [skill.name, skill.description, skill.owner?.name, skill.owner?.id].some(
        value => typeof value === 'string' && value.toLowerCase().includes(term)
      )
    );
  }, [skills, search]);

  const done = text => {
    setNotice(text);
    load();
  };

  const confirmDelete = async () => {
    const skill = deleting;
    setDeleting(null);
    try {
      await deleteUserSkill(skill.id);
      done(t('admin.skills.userSkills.deleted', 'Skill deleted'));
    } catch (err) {
      setError(skillErrorMessage(err, t));
    }
  };

  const formatDate = value => (value ? new Date(value).toLocaleString(i18n.language) : '—');

  const columns = [
    {
      key: 'name',
      header: t('admin.skills.table.name', 'Name'),
      sortable: true,
      sortAccessor: skill => skill.name,
      render: skill => (
        <div className="flex items-center min-w-0">
          <div className="shrink-0 h-8 w-8 rounded-full bg-emerald-100 dark:bg-emerald-900/50 flex items-center justify-center">
            <Icon name="sparkles" className="h-4 w-4 text-emerald-700 dark:text-emerald-300" />
          </div>
          <div className="ml-3 min-w-0">
            <div className="text-sm font-medium font-mono text-gray-900 dark:text-gray-100 truncate">
              {skill.name}
            </div>
            {skill.description && (
              <div className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-xs">
                {skill.description}
              </div>
            )}
            {skill.promotedTo?.skillName && (
              <div className="text-xs text-indigo-600 dark:text-indigo-400">
                {t('admin.skills.userSkills.promotedTo', {
                  defaultValue: 'Promoted to {{name}}',
                  name: skill.promotedTo.skillName
                })}
              </div>
            )}
          </div>
        </div>
      )
    },
    {
      key: 'owner',
      header: t('admin.skills.userSkills.owner', 'Owner'),
      sortable: true,
      sortAccessor: skill => skill.owner?.name || '',
      render: skill => (
        <div className="text-sm text-gray-700 dark:text-gray-300">
          {skill.owner?.name || skill.owner?.id}
          {skill.owner?.active === false && (
            <span className="ml-2 px-1.5 py-0.5 rounded-full text-xs bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-300">
              {t('admin.skills.userSkills.inactive', 'inactive')}
            </span>
          )}
        </div>
      )
    },
    {
      key: 'shared',
      header: t('admin.skills.userSkills.sharedWith', 'Shared with'),
      hideBelow: 'md',
      render: skill => <ShareSummary skill={skill} />
    },
    {
      key: 'updated',
      header: t('admin.skills.userSkills.updated', 'Last changed'),
      sortable: true,
      sortAccessor: skill => skill.updatedAt || '',
      hideBelow: 'lg',
      render: skill => (
        <div className="text-xs text-gray-500 dark:text-gray-400">
          {formatDate(skill.updatedAt)}
          {skill.updatedBy ? ` · ${skill.updatedBy}` : ''}
        </div>
      )
    }
  ];

  const actions = [
    {
      id: 'edit',
      label: t('admin.skills.edit', 'Edit'),
      icon: 'pencil',
      priority: 'primary',
      onClick: skill => setEditing(skill)
    },
    {
      id: 'promote',
      label: t('admin.skills.userSkills.promote', 'Promote'),
      icon: 'arrow-up',
      priority: 'primary',
      onClick: skill => setPromoting(skill)
    },
    {
      id: 'share',
      label: t('skills.actions.share', 'Share'),
      icon: 'users',
      onClick: skill => setSharing(skill)
    },
    {
      id: 'history',
      label: t('skills.actions.history', 'History'),
      icon: 'clock',
      onClick: skill => setHistory(skill)
    },
    {
      id: 'delete',
      label: t('admin.skills.delete', 'Delete'),
      icon: 'trash',
      destructive: true,
      onClick: skill => setDeleting(skill)
    }
  ];

  return (
    <div className="mt-6">
      <p className="text-sm text-gray-600 dark:text-gray-300">
        {t(
          'admin.skills.userSkills.intro',
          'Skills users have shared with a group or with everyone. You can edit, re-share, delete or promote them to a global skill; private skills and skills shared with named users only are not listed.'
        )}
      </p>
      <UserSkillSettingsPanel />

      {!available && (
        <p className="mt-4 text-sm text-amber-700 dark:text-amber-300">
          {t(
            'admin.skills.userSkills.storageDown',
            'The storage provider is not available, so users cannot keep skills right now.'
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
          placeholder={t('admin.skills.searchPlaceholder', 'Search skills...')}
        />
        {truncated && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {t('admin.skills.userSkills.truncated', 'Showing the first skills only')}
          </span>
        )}
      </div>

      <div className="mt-4">
        <DataTable
          columns={columns}
          data={filtered}
          getRowId={skill => skill.id}
          actions={actions}
          loading={loading}
          onRowClick={skill => setPreview({ ...skill, scope: skill.scope || 'shared' })}
          empty={{
            icon: 'users',
            title: t('admin.skills.userSkills.empty', 'No shared user skills'),
            description: t(
              'admin.skills.userSkills.emptyDesc',
              'When users share skills with a group or with everyone, they show up here.'
            )
          }}
        />
      </div>

      {preview && <SkillDetailsModal skill={preview} onClose={() => setPreview(null)} />}
      {editing && (
        <SkillEditorModal
          skill={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            done(t('skills.notices.saved', 'Skill saved'));
          }}
        />
      )}
      {sharing && (
        <SkillShareDialog
          skill={sharing}
          onClose={() => setSharing(null)}
          onSaved={() => {
            setSharing(null);
            done(t('skills.notices.shared', 'Sharing updated'));
          }}
        />
      )}
      {history && (
        <SkillVersionsModal
          skill={history}
          canRestore
          onClose={() => setHistory(null)}
          onRestored={() => {
            setHistory(null);
            done(t('skills.notices.restored', 'Version restored'));
          }}
        />
      )}
      {promoting && (
        <PromoteDialog
          skill={promoting}
          onClose={() => setPromoting(null)}
          onPromoted={result => {
            setPromoting(null);
            done(
              t('admin.skills.userSkills.promoted', {
                defaultValue: 'Promoted to global skill {{name}}',
                name: result?.name || ''
              })
            );
            onGlobalSkillsChanged?.();
          }}
        />
      )}
      <ConfirmDialog
        isOpen={Boolean(deleting)}
        title={t('skills.delete.title', 'Delete skill?')}
        message={t('admin.skills.userSkills.deleteMessage', {
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

export default AdminUserSkillsTab;
