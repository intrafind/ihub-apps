import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMyExecutions } from '../hooks';
import WorkflowListTab from './WorkflowListTab';
import MyExecutionsTab from './MyExecutionsTab';
import Icon from '../../../shared/components/Icon';

/**
 * Main workflows page with tabs for available workflows and user's executions.
 */
function WorkflowsPage() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState('available');

  // Get running count for badge
  const { runningCount } = useMyExecutions();

  const tabs = [
    {
      id: 'available',
      label: t('workflows.tabs.available', 'Available Workflows'),
      icon: 'squares-2x2'
    },
    {
      id: 'my-executions',
      label: t('workflows.tabs.myExecutions', 'My Executions'),
      icon: 'queue-list',
      badge: runningCount > 0 ? runningCount : null
    }
  ];

  return (
    <div className="container mx-auto px-4 py-8">
      {/* Header */}
      <div className="text-center mb-8">
        <h1 className="text-3xl font-bold mb-2 flex items-center justify-center">
          <Icon name="workflow" className="text-indigo-600 w-10 h-10 mr-3" />
          {t('workflows.title', 'Workflows')}
        </h1>
        <p className="text-gray-600 dark:text-gray-400">
          {t('workflows.subtitle', 'Manage and run automated workflows')}
        </p>
      </div>

      {/* Tabs */}
      <div className="flex justify-center mb-8">
        <div className="inline-flex bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all ${
                activeTab === tab.id
                  ? 'bg-white dark:bg-gray-700 text-indigo-600 dark:text-indigo-400 shadow-sm'
                  : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
              }`}
            >
              <Icon name={tab.icon} className="w-5 h-5" />
              {tab.label}
              {tab.badge && (
                <span className="inline-flex items-center justify-center w-5 h-5 text-xs font-bold text-white bg-red-500 rounded-full">
                  {tab.badge}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="max-w-5xl mx-auto">
        {activeTab === 'available' && <WorkflowListTab />}
        {activeTab === 'my-executions' && <MyExecutionsTab />}
      </div>
    </div>
  );
}

export default WorkflowsPage;
