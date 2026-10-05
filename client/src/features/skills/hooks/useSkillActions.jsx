import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { deleteUserSkill, duplicateGlobalSkill, duplicateUserSkill } from '../../../api';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import SkillEditorModal from '../components/SkillEditorModal';
import SkillShareDialog from '../components/SkillShareDialog';
import SkillVersionsModal from '../components/SkillVersionsModal';
import { skillErrorMessage } from '../utils/skillErrors';

/**
 * Everything one can do with a skill in the library, and the dialogs that go
 * with it — the skill counterpart of `usePromptActions`.
 *
 * - **create / edit / share / history / delete** open their dialogs; the
 *   server decides, and the `permissions` on each skill only hide what it
 *   would refuse.
 * - **duplicate** copies a personal skill — or, for a global skill, "Copy to
 *   my skills" — and opens the copy in the editor: a copy is made to be
 *   changed.
 *
 * @param {Object} options
 * @param {(skill?: Object|null) => void} [options.onChanged] - Called after a
 *   skill was created, changed, copied, shared, restored or deleted.
 * @returns {Object} Handlers, the latest notice, and the `dialogs` to render.
 */
export default function useSkillActions({ onChanged } = {}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(null);
  const [sharing, setSharing] = useState(null);
  const [history, setHistory] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [notice, setNotice] = useState(null);

  const changed = useCallback(skill => onChanged?.(skill), [onChanged]);

  const create = useCallback((initial = {}) => setEditing({ initial }), []);
  const edit = useCallback(skill => setEditing({ skill }), []);
  const share = useCallback(skill => setSharing(skill), []);
  const showHistory = useCallback(skill => setHistory(skill), []);
  const remove = useCallback(skill => setDeleting(skill), []);

  const duplicate = useCallback(
    async skill => {
      try {
        const copy =
          skill.scope === 'global'
            ? await duplicateGlobalSkill(skill.name)
            : await duplicateUserSkill(skill.id);
        changed(copy);
        setNotice({
          type: 'success',
          text:
            skill.scope === 'global'
              ? t('skills.notices.copied', 'Copied to your skills')
              : t('skills.notices.duplicated', 'Skill duplicated')
        });
        setEditing({ skill: copy });
      } catch (err) {
        setNotice({ type: 'error', text: skillErrorMessage(err, t) });
      }
    },
    [changed, t]
  );

  const confirmDelete = async () => {
    const skill = deleting;
    setDeleting(null);
    try {
      await deleteUserSkill(skill.id);
      setNotice({ type: 'success', text: t('skills.notices.deleted', 'Skill deleted') });
      changed(null);
    } catch (err) {
      setNotice({ type: 'error', text: skillErrorMessage(err, t) });
    }
  };

  const dialogs = (
    <>
      {editing && (
        <SkillEditorModal
          skill={editing.skill}
          initial={editing.initial}
          onClose={() => setEditing(null)}
          onSaved={saved => {
            setEditing(null);
            setNotice({ type: 'success', text: t('skills.notices.saved', 'Skill saved') });
            changed(saved);
          }}
        />
      )}
      {sharing && (
        <SkillShareDialog
          skill={sharing}
          onClose={() => setSharing(null)}
          onSaved={saved => {
            setSharing(null);
            setNotice({ type: 'success', text: t('skills.notices.shared', 'Sharing updated') });
            changed(saved);
          }}
        />
      )}
      {history && (
        <SkillVersionsModal
          skill={history}
          canRestore={Boolean(history.permissions?.canEdit)}
          onClose={() => setHistory(null)}
          onRestored={restored => {
            setHistory(null);
            setNotice({ type: 'success', text: t('skills.notices.restored', 'Version restored') });
            changed(restored);
          }}
        />
      )}
      <ConfirmDialog
        isOpen={Boolean(deleting)}
        title={t('skills.delete.title', 'Delete skill?')}
        message={t('skills.delete.message', {
          defaultValue:
            '“{{name}}” and its history will be deleted for you and everyone it is shared with.',
          name: deleting?.name || ''
        })}
        confirmLabel={t('common.delete', 'Delete')}
        denyLabel={t('common.cancel', 'Cancel')}
        danger
        onConfirm={confirmDelete}
        onDeny={() => setDeleting(null)}
      />
    </>
  );

  return {
    create,
    edit,
    share,
    duplicate,
    showHistory,
    remove,
    notice,
    clearNotice: () => setNotice(null),
    dialogs
  };
}
