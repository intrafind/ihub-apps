import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { PromptScopeBadge } from '../../prompts/components/PromptMeta';

/**
 * A skill in the library grid, next to the prompt cards: name, a "Skill"
 * badge, its scope, the description, and the actions the caller may take.
 * Clicking the card opens the skill's details. Global skills can only be
 * viewed and copied into one's own skills; editing and duplicating follow the
 * `permissions` the server sent.
 *
 * @param {Object} props
 * @param {Object} props.skill - A library entry (`_type: 'skill'`, global or personal).
 * @param {boolean} props.userSkillsEnabled - Whether the caller may keep skills of their own.
 * @param {(skill: Object) => void} props.onOpen - Show the details.
 * @param {(skill: Object) => void} props.onDuplicate - Duplicate, or "Copy to my skills".
 * @param {(skill: Object) => void} props.onEdit - Open the editor.
 */
function SkillCard({ skill, userSkillsEnabled, onOpen, onDuplicate, onEdit }) {
  const { t } = useTranslation();
  const isGlobal = skill.scope === 'global';
  const canCopy = userSkillsEnabled && (isGlobal || skill.permissions?.canDuplicate === true);
  const copyLabel = isGlobal
    ? t('skills.actions.copyToMine', 'Copy to my skills')
    : t('skills.actions.duplicate', 'Duplicate');

  return (
    <div
      data-testid="skill-card"
      data-skill-id={skill.id}
      className="group relative bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xs hover:shadow-md hover:border-purple-300 dark:hover:border-purple-600 transition-all duration-200 transform hover:-translate-y-0.5 cursor-pointer"
      onClick={() => onOpen(skill)}
      onKeyDown={e => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(skill);
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={t('skills.actions.detailsNamed', {
        defaultValue: 'Show skill {{name}}',
        name: skill.name
      })}
    >
      <div className="p-4 h-full flex flex-col">
        <div className="flex items-start space-x-3 mb-2">
          <div className="shrink-0 w-8 h-8 bg-purple-100 dark:bg-purple-900/50 rounded-lg flex items-center justify-center">
            <Icon name="sparkles" className="w-4 h-4 text-purple-600 dark:text-purple-400" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold font-mono text-gray-900 dark:text-gray-100 text-sm leading-5 mb-1 truncate">
              {skill.name}
            </h3>
            <div className="flex flex-wrap items-center gap-1">
              <span className="px-1.5 py-0.5 text-xs text-purple-700 dark:text-purple-300 bg-purple-100 dark:bg-purple-900/50 rounded-full">
                {t('skills.badge', 'Skill')}
              </span>
              {(userSkillsEnabled || !isGlobal) && <PromptScopeBadge prompt={skill} />}
              {!isGlobal && skill.fileCount > 0 && (
                <span className="px-1.5 py-0.5 text-xs text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-full">
                  {t('skills.list.fileCount', {
                    defaultValue: '{{count}} file(s)',
                    count: skill.fileCount
                  })}
                </span>
              )}
            </div>
          </div>
        </div>

        <p
          className="text-xs text-gray-500 dark:text-gray-400 leading-4 grow overflow-hidden mb-4"
          style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' }}
        >
          {skill.description}
        </p>

        <div className="flex flex-wrap gap-2 mt-auto justify-start">
          <button
            type="button"
            onClick={e => {
              e.stopPropagation();
              onOpen(skill);
            }}
            className="px-3 py-1.5 text-xs border border-purple-600 text-purple-700 dark:border-purple-400 dark:text-purple-300 rounded-lg hover:bg-purple-50 dark:hover:bg-purple-900/40 transition-colors flex items-center justify-center gap-1"
          >
            <Icon name="information-circle" size="sm" />
            <span>{t('skills.actions.details', 'Details')}</span>
          </button>
          {canCopy && (
            <button
              type="button"
              onClick={e => {
                e.stopPropagation();
                onDuplicate(skill);
              }}
              className="px-2 py-1.5 text-xs border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors flex items-center justify-center gap-1"
              aria-label={copyLabel}
              title={copyLabel}
            >
              <Icon name="document-duplicate" size="sm" />
              {isGlobal && <span>{copyLabel}</span>}
            </button>
          )}
          {userSkillsEnabled && skill.permissions?.canEdit && (
            <button
              type="button"
              onClick={e => {
                e.stopPropagation();
                onEdit(skill);
              }}
              className="px-2 py-1.5 text-xs border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors flex items-center justify-center"
              aria-label={t('common.edit', 'Edit')}
              title={t('common.edit', 'Edit')}
            >
              <Icon name="pencil" size="sm" />
            </button>
          )}
        </div>
      </div>
      <div className="absolute inset-0 rounded-xl border border-transparent group-hover:border-purple-200 dark:group-hover:border-purple-700 transition-colors pointer-events-none"></div>
    </div>
  );
}

export default SkillCard;
