import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

const QuickActions = ({ isEnabled }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div className="mb-12 bg-white rounded-lg shadow-sm border border-gray-200 p-6">
      <h2 className="text-xl font-semibold text-gray-900 mb-6">
        {t('admin.home.quickActions', 'Quick Actions')}
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {isEnabled('apps') && (
          <button
            onClick={() => navigate('/admin/apps/new')}
            className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500"
          >
            <Icon name="plus" className="h-4 w-4 mr-2" />
            {t('admin.home.addNewApp', 'Add New App')}
          </button>
        )}

        {isEnabled('models') && (
          <button
            onClick={() => navigate('/admin/models/new')}
            className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-purple-500"
          >
            <Icon name="plus" className="h-4 w-4 mr-2" />
            {t('admin.home.addNewModel', 'Add New Model')}
          </button>
        )}

        {isEnabled('prompts') && (
          <button
            onClick={() => navigate('/admin/prompts/new')}
            className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
          >
            <Icon name="plus" className="h-4 w-4 mr-2" />
            {t('admin.home.addNewPrompt', 'Add New Prompt')}
          </button>
        )}
        <Link
          to="/"
          className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
        >
          <Icon name="home" className="h-4 w-4 mr-2" />
          {t('admin.home.backToApps', 'Back to Apps')}
        </Link>
      </div>
    </div>
  );
};

export default QuickActions;
