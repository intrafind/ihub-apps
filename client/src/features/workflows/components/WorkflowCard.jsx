import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import Icon from '../../../shared/components/Icon';

/**
 * Card component displaying a workflow definition.
 *
 * @param {Object} props - Component props
 * @param {Object} props.workflow - Workflow definition object
 * @param {Function} props.onStart - Callback when start button is clicked
 */
function WorkflowCard({ workflow, onStart }) {
  const { i18n } = useTranslation();
  const currentLanguage = i18n.language;

  const name = getLocalizedContent(workflow.name, currentLanguage) || workflow.id;
  const description = getLocalizedContent(workflow.description, currentLanguage) || '';

  // Count node types for display
  const nodeTypes =
    workflow.nodes?.reduce((acc, node) => {
      acc[node.type] = (acc[node.type] || 0) + 1;
      return acc;
    }, {}) || {};

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md hover:shadow-lg transition-shadow duration-200 overflow-hidden">
      {/* Header with icon */}
      <div className="bg-gradient-to-r from-indigo-500 to-purple-600 px-4 py-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-white/30 rounded-full flex items-center justify-center">
            <Icon name="workflow" className="text-white w-6 h-6" />
          </div>
          <h3 className="font-bold text-lg text-white truncate flex-1">{name}</h3>
        </div>
      </div>

      {/* Body */}
      <div className="p-4">
        <p className="text-gray-600 dark:text-gray-300 text-sm mb-4 line-clamp-2">{description}</p>

        {/* Node type badges */}
        <div className="flex flex-wrap gap-2 mb-4">
          {nodeTypes.agent > 0 && (
            <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
              <Icon name="cpu" className="w-3 h-3 mr-1" />
              {nodeTypes.agent} Agent{nodeTypes.agent > 1 ? 's' : ''}
            </span>
          )}
          {nodeTypes.tool > 0 && (
            <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
              <Icon name="wrench" className="w-3 h-3 mr-1" />
              {nodeTypes.tool} Tool{nodeTypes.tool > 1 ? 's' : ''}
            </span>
          )}
          {nodeTypes.human > 0 && (
            <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200">
              <Icon name="hand-raised" className="w-3 h-3 mr-1" />
              {nodeTypes.human} Checkpoint{nodeTypes.human > 1 ? 's' : ''}
            </span>
          )}
          {nodeTypes.decision > 0 && (
            <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200">
              <Icon name="arrows-right-left" className="w-3 h-3 mr-1" />
              {nodeTypes.decision} Decision{nodeTypes.decision > 1 ? 's' : ''}
            </span>
          )}
        </div>

        {/* Version badge */}
        {workflow.version && (
          <div className="text-xs text-gray-500 dark:text-gray-400 mb-3">v{workflow.version}</div>
        )}

        {/* Start button */}
        <button
          onClick={() => onStart(workflow)}
          className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2 px-4 rounded-lg transition-colors flex items-center justify-center gap-2"
        >
          <Icon name="play" className="w-4 h-4" />
          Start Workflow
        </button>
      </div>
    </div>
  );
}

export default WorkflowCard;
