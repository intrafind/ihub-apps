import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../shared/components/Modal';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import { fetchUserSkill, fetchUserSkillShareTargets, updateUserSkillShares } from '../../../api';
import PromptShareDialog from '../../prompts/components/PromptShareDialog';
import { skillErrorMessage } from '../utils/skillErrors';

/**
 * Who a personal skill is shared with — the prompt share dialog with the
 * skill API calls and texts. A list entry may come without its share list;
 * the skill is then loaded first, so saving never drops existing shares.
 *
 * @param {Object} props
 * @param {Object} props.skill - The user skill (`id`, `name`, optional `shares`).
 * @param {() => void} props.onClose
 * @param {(skill: Object) => void} props.onSaved
 */
function SkillShareDialog({ skill, onClose, onSaved }) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState(() => (Array.isArray(skill.shares) ? skill : null));
  const [error, setError] = useState(null);

  useEffect(() => {
    if (Array.isArray(skill.shares)) return undefined;
    let active = true;
    fetchUserSkill(skill.id)
      .then(detail => {
        if (active) setLoaded({ ...detail, shares: detail?.shares || [] });
      })
      .catch(err => {
        if (active) setError(skillErrorMessage(err, t));
      });
    return () => {
      active = false;
    };
  }, [skill, t]);

  if (!loaded) {
    return (
      <Modal isOpen onClose={onClose} maxWidthClassName="max-w-xl">
        <div className="p-6">
          {error ? (
            <p className="text-sm text-red-600 dark:text-red-400" role="alert">
              {error}
            </p>
          ) : (
            <LoadingSpinner />
          )}
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
            >
              {t('common.close', 'Close')}
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <PromptShareDialog
      prompt={loaded}
      onClose={onClose}
      onSaved={onSaved}
      fetchTargets={fetchUserSkillShareTargets}
      saveShares={updateUserSkillShares}
      errorMessage={skillErrorMessage}
      labels={{
        title: t('skills.share.title', 'Share skill'),
        private: t('skills.share.private', 'Only you — this skill is private'),
        help: t(
          'skills.share.help',
          '“Can use” lets people use the skill in chats and duplicate it. “Can edit” also lets them change it and share it further.'
        )
      }}
    />
  );
}

export default SkillShareDialog;
