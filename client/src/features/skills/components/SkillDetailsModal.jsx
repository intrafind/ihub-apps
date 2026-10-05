import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../shared/components/Modal';
import Icon from '../../../shared/components/Icon';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import { fetchSkillContent, fetchUserSkill } from '../../../api';
import { buildPath } from '../../../utils/runtimeBasePath';
import { PromptAttribution, PromptScopeBadge } from '../../prompts/components/PromptMeta';
import { skillErrorMessage } from '../utils/skillErrors';
import SkillFileList from './SkillFileList';

const secondaryButton =
  'px-3 py-1.5 text-sm border border-indigo-600 dark:border-indigo-400 text-indigo-600 dark:text-indigo-400 rounded-md hover:bg-indigo-50 dark:hover:bg-indigo-900/50 inline-flex items-center gap-1';

/**
 * Load what the details show beyond the list entry: the instructions and the
 * files. Global skills come from `/api/skills/:name/content` (file paths
 * only), personal ones from `/api/user-skills/:id` (with file contents).
 *
 * @param {string} scope - `global`, `mine` or `shared`.
 * @param {string} id - The skill id (`usk_…` for a personal skill).
 * @param {string} name - The skill name (addresses a global skill).
 * @returns {Promise<{body: string, files: Array}>}
 */
async function loadSkillContent(scope, id, name) {
  if (scope === 'global') {
    const content = await fetchSkillContent(name);
    return {
      body: content?.body || '',
      files: [
        ...(content?.references || []),
        ...(content?.assets || []),
        ...(content?.scripts || [])
      ]
    };
  }
  const detail = await fetchUserSkill(id);
  return { ...detail, body: detail?.body || '', files: detail?.files || [] };
}

/**
 * A skill's details — description, instructions, files — and what the caller
 * may do with it. Global skills can only be viewed and copied into one's own
 * skills; for personal skills the `permissions` the server sent decide which
 * actions show. An action without a handler is not offered.
 *
 * @param {Object} props
 * @param {Object} props.skill - A list entry (global or personal).
 * @param {() => void} props.onClose
 * @param {(skill: Object) => void} [props.onEdit]
 * @param {(skill: Object) => void} [props.onShare]
 * @param {(skill: Object) => void} [props.onDuplicate] - Duplicate, or "Copy to my skills" for a global skill.
 * @param {(skill: Object) => void} [props.onHistory]
 * @param {(skill: Object) => void} [props.onDelete]
 */
function SkillDetailsModal({ skill, onClose, onEdit, onShare, onDuplicate, onHistory, onDelete }) {
  const { t } = useTranslation();
  const [content, setContent] = useState(null);
  const [error, setError] = useState(null);
  const [linkStatus, setLinkStatus] = useState('idle');

  const { scope: skillScope, id: skillId, name: skillName } = skill;
  useEffect(() => {
    let active = true;
    loadSkillContent(skillScope, skillId, skillName)
      .then(result => active && setContent(result))
      .catch(err => active && setError(skillErrorMessage(err, t)));
    return () => {
      active = false;
    };
  }, [skillScope, skillId, skillName, t]);

  const isGlobal = skill.scope === 'global';
  const permissions = skill.permissions || {};

  const handleCopyLink = async () => {
    const url = `${window.location.origin}${buildPath(`/prompts?skill=${encodeURIComponent(skill.id)}`)}`;
    try {
      await navigator.clipboard.writeText(url);
      setLinkStatus('success');
    } catch (err) {
      console.error('Failed to copy skill link:', err);
      setLinkStatus('error');
    }
    setTimeout(() => setLinkStatus('idle'), 2000);
  };

  return (
    <Modal isOpen onClose={onClose} maxWidthClassName="max-w-2xl">
      <div className="p-6 flex flex-col min-h-0">
        <div className="flex justify-between items-start mb-3 gap-3">
          <div className="min-w-0">
            <h2 className="text-xl font-semibold flex items-center text-gray-900 dark:text-gray-100">
              <Icon name="sparkles" className="w-6 h-6 mr-2 shrink-0 text-purple-600" />
              <span className="truncate font-mono">{skill.name}</span>
            </h2>
            {skill.displayName && skill.displayName !== skill.name && (
              <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">{skill.displayName}</p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <PromptScopeBadge prompt={skill} />
              {skill.promotedTo?.skillName && (
                <span className="px-1.5 py-0.5 text-xs text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/50 rounded-full">
                  {t('skills.details.promotedTo', {
                    defaultValue: 'Promoted to global skill {{name}}',
                    name: skill.promotedTo.skillName
                  })}
                </span>
              )}
              {skill.copiedFrom?.id && (
                <span className="px-1.5 py-0.5 text-xs text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-full">
                  {skill.copiedFrom.scope === 'marketplace'
                    ? t('skills.details.fromMarketplace', {
                        defaultValue: 'From the marketplace: {{name}} ({{registry}})',
                        name: skill.copiedFrom.id,
                        registry: skill.copiedFrom.registryName || skill.copiedFrom.registryId
                      })
                    : t('skills.details.copiedFrom', {
                        defaultValue: 'Copied from {{name}}',
                        name: skill.copiedFrom.id
                      })}
                </span>
              )}
              {skill.copiedFrom?.scope === 'marketplace' && skill.copiedFrom.license && (
                <span className="px-1.5 py-0.5 text-xs text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-full">
                  {t('skills.details.license', {
                    defaultValue: 'License: {{license}}',
                    license: skill.copiedFrom.license
                  })}
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close', 'Close')}
            className="text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          >
            <Icon name="x" />
          </button>
        </div>

        <div className="overflow-y-auto min-h-0 max-h-[55vh] pr-1">
          {skill.description && (
            <p className="text-gray-700 dark:text-gray-300 mb-3 whitespace-pre-line">
              {skill.description}
            </p>
          )}
          {error ? (
            <p className="text-sm text-red-600 dark:text-red-400 mb-3" role="alert">
              {error}
            </p>
          ) : !content ? (
            <div className="py-4">
              <LoadingSpinner />
            </div>
          ) : (
            <>
              <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">
                {t('skills.details.instructions', 'Instructions')}
              </div>
              <pre className="bg-gray-100 dark:bg-gray-900 text-gray-900 dark:text-gray-100 p-3 rounded-sm whitespace-pre-wrap wrap-break-word mb-3 text-sm">
                {content.body}
              </pre>
              <SkillFileList files={content.files} className="mb-3" />
            </>
          )}
        </div>

        {!isGlobal && (
          <div className="mb-4">
            <PromptAttribution prompt={skill} />
          </div>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          {permissions.canEdit && onEdit && (
            <button type="button" onClick={() => onEdit(skill)} className={secondaryButton}>
              <Icon name="pencil" size="sm" />
              {t('common.edit', 'Edit')}
            </button>
          )}
          {permissions.canShare && onShare && (
            <button type="button" onClick={() => onShare(skill)} className={secondaryButton}>
              <Icon name="users" size="sm" />
              {t('skills.actions.share', 'Share')}
            </button>
          )}
          {onDuplicate && (isGlobal || permissions.canDuplicate) && (
            <button type="button" onClick={() => onDuplicate(skill)} className={secondaryButton}>
              <Icon name="document-duplicate" size="sm" />
              {isGlobal
                ? t('skills.actions.copyToMine', 'Copy to my skills')
                : t('skills.actions.duplicate', 'Duplicate')}
            </button>
          )}
          {!isGlobal && (permissions.canEdit || skill.scope === 'mine') && onHistory && (
            <button type="button" onClick={() => onHistory(skill)} className={secondaryButton}>
              <Icon name="clock" size="sm" />
              {t('skills.actions.history', 'History')}
            </button>
          )}
          <button
            type="button"
            onClick={handleCopyLink}
            className={secondaryButton}
            aria-label={t('skills.actions.copyLink', 'Copy link')}
            title={t('skills.actions.copyLink', 'Copy link')}
          >
            {linkStatus === 'success' ? (
              <Icon name="check-circle" className="text-green-600" solid />
            ) : linkStatus === 'error' ? (
              <Icon name="exclamation-circle" className="text-red-600" solid />
            ) : (
              <Icon name="link" />
            )}
          </button>
          {permissions.canDelete && onDelete && (
            <button
              type="button"
              onClick={() => onDelete(skill)}
              className="px-3 py-1.5 text-sm border border-red-600 text-red-600 dark:border-red-400 dark:text-red-400 rounded-md hover:bg-red-50 dark:hover:bg-red-900/30 inline-flex items-center gap-1"
            >
              <Icon name="trash" size="sm" />
              {t('common.delete', 'Delete')}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

export default SkillDetailsModal;
