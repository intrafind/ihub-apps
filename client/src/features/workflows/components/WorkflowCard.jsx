import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import Icon from '../../../shared/components/Icon';
import { useTechnicalDetailsToggle } from '../hooks/useTechnicalDetailsToggle';

/**
 * Card component displaying a workflow definition.
 *
 * @param {Object} props - Component props
 * @param {Object} props.workflow - Workflow definition object
 * @param {Function} props.onStart - Callback when start button is clicked
 */
function WorkflowCard({ workflow, onStart }) {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const [showTechnical] = useTechnicalDetailsToggle();

  const name = getLocalizedContent(workflow.name, currentLanguage) || workflow.id;
  const description = getLocalizedContent(workflow.description, currentLanguage) || '';

  const nodeTypes =
    workflow.nodes?.reduce((acc, node) => {
      acc[node.type] = (acc[node.type] || 0) + 1;
      return acc;
    }, {}) || {};

  const stepCount = workflow.nodes?.length || 0;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md hover:shadow-lg transition-shadow duration-200 overflow-hidden border-l-4 border-indigo-500 flex flex-col">
      <div className="p-4 flex-1 flex flex-col">
        <div className="flex items-start gap-3 mb-3">
          <div
            className="flex-shrink-0 w-10 h-10 bg-indigo-100 dark:bg-indigo-900/40 rounded-full flex items-center justify-center"
            aria-hidden="true"
          >
            <Icon name="workflow" className="text-indigo-600 dark:text-indigo-400 w-5 h-5" />
          </div>
          <h3 className="font-semibold text-base text-gray-900 dark:text-white leading-snug">
            {name}
          </h3>
        </div>

        <p className="text-gray-600 dark:text-gray-300 text-sm mb-4 line-clamp-3 flex-1">
          {description}
        </p>

        <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400 mb-4">
          <span className="inline-flex items-center gap-1">
            <Icon name="cube" className="w-3.5 h-3.5" aria-hidden="true" />
            {stepCount === 1
              ? t('workflows.startModal.aboutSteps_one', '{{count}} step', { count: stepCount })
              : t('workflows.startModal.aboutSteps', '{{count}} steps', { count: stepCount })}
          </span>
          {workflow.version && (
            <span aria-label={`Version ${workflow.version}`}>v{workflow.version}</span>
          )}
        </div>

        {showTechnical && (
          <div className="flex flex-wrap gap-1.5 mb-4">
            {nodeTypes.prompt > 0 && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200">
                <Icon name="cpu" className="w-3 h-3 mr-1" aria-hidden="true" />
                {nodeTypes.prompt} prompt{nodeTypes.prompt > 1 ? 's' : ''}
              </span>
            )}
            {nodeTypes.tool > 0 && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200">
                <Icon name="wrench" className="w-3 h-3 mr-1" aria-hidden="true" />
                {nodeTypes.tool} tool{nodeTypes.tool > 1 ? 's' : ''}
              </span>
            )}
            {nodeTypes.human > 0 && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-200">
                <Icon name="hand-raised" className="w-3 h-3 mr-1" aria-hidden="true" />
                {nodeTypes.human} checkpoint{nodeTypes.human > 1 ? 's' : ''}
              </span>
            )}
            {nodeTypes.decision > 0 && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200">
                <Icon name="arrows-right-left" className="w-3 h-3 mr-1" aria-hidden="true" />
                {nodeTypes.decision} decision{nodeTypes.decision > 1 ? 's' : ''}
              </span>
            )}
          </div>
        )}

        <button
          onClick={() => onStart(workflow)}
          className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2 px-4 rounded-lg transition-colors flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
        >
          <Icon name="play" className="w-4 h-4" aria-hidden="true" />
          {t('workflows.start', 'Start workflow')}
        </button>
      </div>
    </div>
  );
}

export default WorkflowCard;
