import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useWorkflowList } from '../hooks';
import { WorkflowCard, StartWorkflowModal } from '../components';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import Icon from '../../../shared/components/Icon';

/**
 * Tab content showing available workflow definitions that the user can start.
 */
function WorkflowListTab() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { workflows, loading, error, refetch } = useWorkflowList();

  const [selectedWorkflow, setSelectedWorkflow] = useState(null);
  const [showStartModal, setShowStartModal] = useState(false);

  const handleStartClick = workflow => {
    setSelectedWorkflow(workflow);
    setShowStartModal(true);
  };

  const handleModalClose = () => {
    setShowStartModal(false);
    setSelectedWorkflow(null);
  };

  const handleWorkflowStarted = executionData => {
    setShowStartModal(false);
    setSelectedWorkflow(null);
    // Navigate to the execution page
    navigate(`/workflows/executions/${executionData.executionId}`);
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <LoadingSpinner message={t('workflows.loading', 'Loading workflows...')} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-12">
        <div className="text-red-500 mb-4">{error}</div>
        <button
          onClick={refetch}
          className="bg-indigo-600 text-white px-4 py-2 rounded-lg hover:bg-indigo-700 transition-colors"
        >
          {t('common.retry', 'Retry')}
        </button>
      </div>
    );
  }

  if (workflows.length === 0) {
    return (
      <div className="text-center py-12">
        <Icon name="inbox" className="w-16 h-16 mx-auto text-gray-300 mb-4" />
        <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
          {t('workflows.noWorkflows.title', 'No Workflows Available')}
        </h3>
        <p className="text-gray-500 dark:text-gray-400">
          {t(
            'workflows.noWorkflows.description',
            'There are no workflows available for you to run.'
          )}
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="grid gap-6 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
        {workflows.map(workflow => (
          <WorkflowCard key={workflow.id} workflow={workflow} onStart={handleStartClick} />
        ))}
      </div>

      <StartWorkflowModal
        workflow={selectedWorkflow}
        isOpen={showStartModal}
        onClose={handleModalClose}
        onStarted={handleWorkflowStarted}
      />
    </>
  );
}

export default WorkflowListTab;
