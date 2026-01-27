import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { makeAdminApiCall } from '../../../api/adminApi';

const LoggingConfig = () => {
  const { t } = useTranslation();
  const [currentLevel, setCurrentLevel] = useState('info');
  const [availableLevels, setAvailableLevels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [changingLevel, setChangingLevel] = useState(false);
  const [message, setMessage] = useState('');

  // Fetch current log level on mount
  useEffect(() => {
    const fetchLogLevel = async () => {
      try {
        const response = await makeAdminApiCall('/admin/logging/level', {
          method: 'GET'
        });
        setCurrentLevel(response.data.current);
        setAvailableLevels(response.data.available);
        setMessage('');
      } catch (error) {
        setMessage({
          type: 'error',
          text: error.message || t('admin.system.logging.levelChangeError')
        });
      } finally {
        setLoading(false);
      }
    };

    fetchLogLevel();
  }, [t]);

  const handleLevelChange = async newLevel => {
    setChangingLevel(true);
    setMessage('');

    try {
      const response = await makeAdminApiCall('/admin/logging/level', {
        method: 'PUT',
        data: {
          level: newLevel,
          persist: true
        }
      });

      setCurrentLevel(newLevel);
      setMessage({
        type: 'success',
        text: t('admin.system.logging.levelChanged', { level: newLevel })
      });
    } catch (error) {
      setMessage({
        type: 'error',
        text: error.message || t('admin.system.logging.levelChangeError')
      });
    } finally {
      setChangingLevel(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <h2 className="text-xl font-semibold mb-4 text-gray-900 dark:text-gray-100">
          {t('admin.system.logging.title')}
        </h2>
        <p className="text-gray-600 dark:text-gray-400">
          {t('common.loading', 'Loading...')}
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
      <div className="flex items-start mb-4">
        <Icon name="AdjustmentsHorizontalIcon" className="w-6 h-6 mr-2 text-blue-500 flex-shrink-0" />
        <div>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            {t('admin.system.logging.title')}
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            {t('admin.system.logging.description')}
          </p>
        </div>
      </div>

      {/* Current Level Display */}
      <div className="mb-6 p-4 bg-gray-50 dark:bg-gray-700 rounded-lg">
        <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {t('admin.system.logging.currentLevel')}:
        </p>
        <p className="text-lg font-bold text-blue-600 dark:text-blue-400">{currentLevel}</p>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
          {t(`admin.system.logging.levelDescriptions.${currentLevel}`, '')}
        </p>
      </div>

      {/* Log Level Selector */}
      <div className="mb-6">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          {t('admin.system.logging.changeLevel')}
        </label>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {availableLevels.map(level => (
            <button
              key={level}
              onClick={() => handleLevelChange(level)}
              disabled={changingLevel || currentLevel === level}
              className={`
                p-3 rounded-lg border-2 text-left transition-all
                ${
                  currentLevel === level
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                    : 'border-gray-200 dark:border-gray-600 hover:border-blue-300 dark:hover:border-blue-500'
                }
                ${changingLevel ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
                disabled:cursor-not-allowed
              `}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="font-semibold text-gray-900 dark:text-gray-100">
                  {t(`admin.system.logging.levels.${level}`, level)}
                </span>
                {currentLevel === level && (
                  <Icon name="CheckCircleIcon" className="w-5 h-5 text-blue-500" />
                )}
              </div>
              <p className="text-xs text-gray-600 dark:text-gray-400">
                {t(`admin.system.logging.levelDescriptions.${level}`, '')}
              </p>
            </button>
          ))}
        </div>
      </div>

      {/* Status Message */}
      {message && (
        <div
          className={`p-4 rounded-lg ${
            message.type === 'success'
              ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300'
              : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'
          }`}
        >
          <div className="flex items-start">
            <Icon
              name={message.type === 'success' ? 'CheckCircleIcon' : 'ExclamationCircleIcon'}
              className="w-5 h-5 mr-2 flex-shrink-0"
            />
            <p className="text-sm">{message.text}</p>
          </div>
        </div>
      )}

      {/* Info Box */}
      <div className="mt-6 p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
        <div className="flex items-start">
          <Icon
            name="InformationCircleIcon"
            className="w-5 h-5 mr-2 text-blue-600 dark:text-blue-400 flex-shrink-0"
          />
          <div className="text-sm text-blue-800 dark:text-blue-300">
            <p className="font-medium mb-1">{t('common.note', 'Note')}:</p>
            <ul className="list-disc list-inside space-y-1 text-xs">
              <li>Changes take effect immediately across all server processes</li>
              <li>Log level changes are persisted to platform.json configuration</li>
              <li>Lower levels (error, warn) show fewer messages, higher levels (debug, silly) show more</li>
              <li>Use &quot;info&quot; level for production, &quot;debug&quot; for development</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LoggingConfig;
