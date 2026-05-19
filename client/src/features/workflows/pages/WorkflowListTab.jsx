import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../../shared/contexts/AuthContext';
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
  const { user } = useAuth();
  const isAdmin = user?.permissions?.adminAccess === true;
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
        <Icon
          name="inbox"
          className="w-16 h-16 mx-auto text-gray-300 dark:text-gray-600 mb-4"
          aria-hidden="true"
        />
        <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
          {t('workflows.emptyState.available.title', 'No workflows available yet')}
        </h3>
        <p className="text-gray-500 dark:text-gray-400 mb-4 max-w-md mx-auto">
          {isAdmin
            ? t(
                'workflows.emptyState.available.bodyAdmin',
                'No workflows have been published yet. Create your first workflow to get started.'
              )
            : t(
                'workflows.emptyState.available.bodyUser',
                "Ask an administrator to publish a workflow that's available to your group."
              )}
        </p>
        {isAdmin && (
          <Link
            to="/admin/workflows/new/edit"
            className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
          >
            <Icon name="plus" className="w-4 h-4" aria-hidden="true" />
            {t('workflows.newWorkflow', 'New Workflow')}
          </Link>
        )}
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
