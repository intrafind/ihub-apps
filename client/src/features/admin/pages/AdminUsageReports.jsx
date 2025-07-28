import { useEffect, useState } from 'react';
import { fetchAdminUsageData } from '../../../api/adminApi';
import { useTranslation } from 'react-i18next';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import Icon from '../../../shared/components/Icon';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';

const StatCard = ({ title, value, icon, color, change, changeType }) => (
  <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
    <div className="flex items-center justify-between">
      <div>
        <p className="text-sm font-medium text-gray-600">{title}</p>
        <p className="text-3xl font-bold text-gray-900">
          {typeof value === 'number' ? new Intl.NumberFormat().format(value) : value}
        </p>
        {change && (
          <p
            className={`text-sm ${changeType === 'positive' ? 'text-green-600' : 'text-red-600'} mt-1`}
          >
            {changeType === 'positive' ? '↗' : '↘'} {change}
          </p>
        )}
      </div>
      <div className={`p-3 rounded-full ${color}`}>{icon}</div>
    </div>
  </div>
);

const TopUsersCard = ({ title, data, color }) => {
  const sortedData = Object.entries(data || {})
    .sort(
      ([, a], [, b]) =>
        (typeof a === 'object' ? (a.good || 0) + (a.bad || 0) : a) -
        (typeof b === 'object' ? (b.good || 0) + (b.bad || 0) : b)
    )
    .reverse()
    .slice(0, 5);

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">{title}</h3>
      <div className="space-y-3">
        {sortedData.map(([key, value], index) => {
          const displayValue =
            typeof value === 'object' ? (value.good || 0) + (value.bad || 0) : value;
          const maxValue = Math.max(
            ...sortedData.map(([, v]) => (typeof v === 'object' ? (v.good || 0) + (v.bad || 0) : v))
          );
          const percentage = maxValue > 0 ? (displayValue / maxValue) * 100 : 0;

          return (
            <div key={key} className="flex items-center justify-between">
              <div className="flex items-center space-x-3 flex-1">
                <div
                  className={`w-8 h-8 rounded-full ${color} flex items-center justify-center text-white text-sm font-medium`}
                >
                  {index + 1}
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium text-gray-900 truncate">
                    {key.replace('session-', '')}
                  </p>
                  <div className="w-full bg-gray-200 rounded-full h-2 mt-1">
                    <div
                      className={`h-2 rounded-full ${color}`}
                      style={{ width: `${percentage}%` }}
                    ></div>
                  </div>
                </div>
              </div>
              <div className="text-sm font-semibold text-gray-900 ml-3">
                {new Intl.NumberFormat().format(displayValue)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const AppUsageCard = ({ data }) => {
  const { t } = useTranslation();
  const apps = Object.entries(data || {});
  const total = apps.reduce(
    (sum, [, value]) =>
      sum + (typeof value === 'object' ? (value.good || 0) + (value.bad || 0) : value),
    0
  );

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">
        {t('admin.usage.appUsageDistribution', 'App Usage Distribution')}
      </h3>
      <div className="space-y-4">
        {apps.map(([app, value]) => {
          const displayValue =
            typeof value === 'object' ? (value.good || 0) + (value.bad || 0) : value;
          const percentage = total > 0 ? (displayValue / total) * 100 : 0;

          return (
            <div key={app} className="space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium text-gray-700 capitalize">
                  {app.replace('-', ' ')}
                </span>
                <span className="text-sm text-gray-600">{percentage.toFixed(1)}%</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-3">
                <div
                  className="bg-gradient-to-r from-blue-500 to-purple-600 h-3 rounded-full transition-all duration-300"
                  style={{ width: `${percentage}%` }}
                ></div>
              </div>
              <div className="text-xs text-gray-500">
                {new Intl.NumberFormat().format(displayValue)} uses
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const FeedbackCard = ({ data }) => {
  const totalFeedback = (data.good || 0) + (data.bad || 0);
  const goodPercentage = totalFeedback > 0 ? ((data.good || 0) / totalFeedback) * 100 : 0;
  const badPercentage = totalFeedback > 0 ? ((data.bad || 0) / totalFeedback) * 100 : 0;

  // New star rating data
  const starRatings = data.ratings || {};
  const totalStarRatings = data.total || 0;
  const averageRating = data.averageRating || 0;

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">
        {t('admin.dashboard.feedbackOverview', 'Feedback Overview')}
      </h3>

      {/* Star Rating Summary (if available) */}
      {totalStarRatings > 0 && (
        <div className="mb-6 p-4 bg-amber-50 rounded-lg">
          <div className="flex items-center justify-center space-x-2 mb-3">
            <div className="flex items-center">
              {[1, 2, 3, 4, 5].map(star => (
                <svg
                  key={star}
                  className={`w-6 h-6 ${
                    star <= Math.round(averageRating) ? 'text-yellow-400' : 'text-gray-300'
                  }`}
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                </svg>
              ))}
            </div>
            <span className="text-2xl font-bold text-amber-600">{averageRating.toFixed(1)}</span>
          </div>
          <div className="text-center">
            <div className="text-sm text-amber-600 font-medium">
              Average Rating ({totalStarRatings} ratings)
            </div>
          </div>

          {/* Star rating breakdown */}
          <div className="mt-4 space-y-2">
            {[5, 4, 3, 2, 1].map(star => {
              const count = starRatings[star] || 0;
              const percentage = totalStarRatings > 0 ? (count / totalStarRatings) * 100 : 0;
              return (
                <div key={star} className="flex items-center space-x-2 text-sm">
                  <span className="w-8 text-gray-600">{star}★</span>
                  <div className="flex-1 bg-gray-200 rounded-full h-2">
                    <div
                      className="bg-yellow-400 h-2 rounded-full transition-all duration-300"
                      style={{ width: `${percentage}%` }}
                    />
                  </div>
                  <span className="w-8 text-gray-600 text-xs">{count}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Legacy positive/negative stats (for backward compatibility) */}
      {totalFeedback > 0 && (
        <>
          <div className="grid grid-cols-2 gap-4 mb-6">
            <div className="text-center p-4 bg-green-50 rounded-lg">
              <div className="text-3xl font-bold text-green-600">{data.good || 0}</div>
              <div className="text-sm text-green-600 font-medium">
                {t('admin.dashboard.positive', 'Positive')}
              </div>
              <div className="text-xs text-green-500">{goodPercentage.toFixed(1)}%</div>
            </div>
            <div className="text-center p-4 bg-red-50 rounded-lg">
              <div className="text-3xl font-bold text-red-600">{data.bad || 0}</div>
              <div className="text-sm text-red-600 font-medium">
                {t('admin.dashboard.negative', 'Negative')}
              </div>
              <div className="text-xs text-red-500">{badPercentage.toFixed(1)}%</div>
            </div>
          </div>
          {/* Visual Progress Bar */}
          <div className="mb-4">
            <div className="flex items-center justify-between text-sm text-gray-600 mb-2">
              <span>{t('admin.dashboard.satisfactionRate', 'Satisfaction Rate')}</span>
              <span>{goodPercentage.toFixed(1)}% positive</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-4 overflow-hidden">
              <div className="h-full flex">
                <div
                  className="bg-green-500 transition-all duration-300"
                  style={{ width: `${goodPercentage}%` }}
                ></div>
                <div
                  className="bg-red-500 transition-all duration-300"
                  style={{ width: `${badPercentage}%` }}
                ></div>
              </div>
            </div>
          </div>
        </>
      )}

      <div className="text-center text-sm text-gray-600">
        Total feedback: {Math.max(totalFeedback, totalStarRatings)} responses
      </div>
    </div>
  );
};

const AdminUsageReports = () => {
  const { t } = useTranslation();
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');

  const load = async () => {
    try {
      setLoading(true);
      const data = await fetchAdminUsageData();
      setUsage(data);
    } catch (e) {
      console.error('Failed to load usage data', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const downloadJson = () => {
    if (!usage) return;
    const blob = new Blob([JSON.stringify(usage, null, 2)], {
      type: 'application/json'
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'usage.json';
    link.click();
    URL.revokeObjectURL(url);
  };

  const downloadCsv = () => {
    if (!usage) return;
    const { messages, tokens, feedback, magicPrompt } = usage;
    const csvData = [
      ['Metric', 'Total', 'Description'],
      ['Messages', messages.total, 'Total messages sent'],
      ['Tokens', tokens.total, 'Total tokens processed'],
      ['Prompt Tokens', tokens.prompt.total, 'Input tokens'],
      ['Completion Tokens', tokens.completion.total, 'Output tokens'],
      ['Feedback Good', feedback.good, 'Positive feedback count'],
      ['Feedback Bad', feedback.bad, 'Negative feedback count'],
      ['Magic Prompt Uses', magicPrompt.total, 'Magic prompt invocations'],
      ['Magic Prompt Input Tokens', magicPrompt.tokensIn.total, 'Magic prompt input tokens'],
      ['Magic Prompt Output Tokens', magicPrompt.tokensOut.total, 'Magic prompt output tokens']
    ];

    const csv = csvData.map(row => row.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'usage-summary.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  if (loading) return <LoadingSpinner />;
  if (!usage)
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="text-red-500 text-6xl mb-4">⚠️</div>
          <h2 className="text-2xl font-bold text-gray-900 mb-2">
            {t('admin.usage.noDataTitle', 'No Data Available')}
          </h2>
          <p className="text-gray-600">
            {t('admin.usage.noDataDesc', 'Unable to load usage statistics.')}
          </p>
        </div>
      </div>
    );

  const { messages, tokens, feedback, magicPrompt, lastUpdated, lastReset } = usage;

  const tabs = [
    {
      id: 'overview',
      label: t('admin.usage.tabs.overview', 'Overview'),
      icon: <Icon name="chart" size="md" />
    },
    {
      id: 'users',
      label: t('admin.usage.tabs.users', 'Users'),
      icon: <Icon name="users" size="md" />
    },
    {
      id: 'apps',
      label: t('admin.usage.tabs.apps', 'Applications'),
      icon: <Icon name="settings" size="md" />
    },
    {
      id: 'magic',
      label: t('admin.usage.tabs.magic', 'Magic Prompt'),
      icon: <Icon name="sparkles" size="md" />
    },
    {
      id: 'feedback',
      label: t('admin.usage.tabs.feedback', 'Feedback'),
      icon: <Icon name="thumbs-up" size="md" />
    },
    {
      id: 'details',
      label: t('admin.usage.tabs.details', 'Details'),
      icon: <Icon name="chat" size="md" />
    }
  ];

  const renderOverview = () => (
    <div className="space-y-6">
      {/* Main Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard
          title={t('admin.usage.totalMessages', 'Total Messages')}
          value={messages.total}
          icon={<Icon name="chat" size="lg" className="text-white" />}
          color="bg-blue-500"
        />
        <StatCard
          title={t('admin.usage.totalTokens', 'Total Tokens')}
          value={tokens.total}
          icon={<Icon name="document-text" size="lg" className="text-white" />}
          color="bg-green-500"
        />
        <StatCard
          title={t('admin.usage.magicPrompts', 'Magic Prompts')}
          value={magicPrompt.total}
          icon={<Icon name="sparkles" size="lg" className="text-white" />}
          color="bg-purple-500"
        />
        <StatCard
          title={t('admin.usage.feedbackScore', 'Feedback Score')}
          value={`${feedback.good}/${feedback.good + feedback.bad}`}
          icon={<Icon name="thumbs-up" size="lg" className="text-white" />}
          color="bg-amber-500"
        />
      </div>

      {/* Token Breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">
            {t('admin.usage.tokenDistribution', 'Token Distribution')}
          </h3>
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <span className="text-gray-600">
                {t('admin.usage.promptTokens', 'Prompt Tokens')}
              </span>
              <span className="font-semibold">
                {new Intl.NumberFormat().format(tokens.prompt.total)}
              </span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-3">
              <div
                className="bg-blue-500 h-3 rounded-l-full"
                style={{ width: `${(tokens.prompt.total / tokens.total) * 100}%` }}
              ></div>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-600">
                {t('admin.usage.completionTokens', 'Completion Tokens')}
              </span>
              <span className="font-semibold">
                {new Intl.NumberFormat().format(tokens.completion.total)}
              </span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-3">
              <div
                className="bg-green-500 h-3 rounded-l-full"
                style={{ width: `${(tokens.completion.total / tokens.total) * 100}%` }}
              ></div>
            </div>
          </div>
        </div>

        <AppUsageCard data={messages.perApp} />
      </div>
    </div>
  );

  const renderUsers = () => (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <TopUsersCard
        title={t('admin.dashboard.topUsersByMessages', 'Top Users by Messages')}
        data={messages.perUser}
        color="bg-blue-500"
      />
      <TopUsersCard
        title={t('admin.dashboard.topUsersByTokens', 'Top Users by Tokens')}
        data={tokens.perUser}
        color="bg-green-500"
      />
      <TopUsersCard
        title={t('admin.dashboard.topUsersByMagicPrompts', 'Top Users by Magic Prompts')}
        data={magicPrompt.perUser}
        color="bg-purple-500"
      />
      <TopUsersCard
        title={t('admin.dashboard.userFeedback', 'User Feedback')}
        data={feedback.perUser}
        color="bg-amber-500"
      />
    </div>
  );

  const renderApps = () => (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <AppUsageCard data={messages.perApp} />
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">
          {t('admin.usage.appTokenUsage', 'App Token Usage')}
        </h3>
        <div className="space-y-4">
          {Object.entries(tokens.perApp || {}).map(([app, tokenCount]) => (
            <div key={app} className="flex justify-between items-center p-3 bg-gray-50 rounded-lg">
              <span className="font-medium capitalize">{app.replace('-', ' ')}</span>
              <span className="text-lg font-bold text-gray-900">
                {new Intl.NumberFormat().format(tokenCount)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  const renderMagic = () => (
    <div className="space-y-6">
      {/* Magic Prompt Overview */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <StatCard
          title={t('admin.dashboard.totalInvocations', 'Total Invocations')}
          value={magicPrompt.total}
          icon={<Icon name="sparkles" size="lg" className="text-white" />}
          color="bg-purple-500"
        />
        <StatCard
          title={t('admin.dashboard.inputTokens', 'Input Tokens')}
          value={magicPrompt.tokensIn.total}
          icon={<Icon name="document-text" size="lg" className="text-white" />}
          color="bg-blue-500"
        />
        <StatCard
          title={t('admin.dashboard.outputTokens', 'Output Tokens')}
          value={magicPrompt.tokensOut.total}
          icon={<Icon name="document-text" size="lg" className="text-white" />}
          color="bg-green-500"
        />
      </div>

      {/* Magic Prompt Details */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <TopUsersCard
          title="Top Users by Magic Prompts"
          data={magicPrompt.perUser}
          color="bg-purple-500"
        />

        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">
            {t('admin.usage.sections.appUsage', 'App Usage')}
          </h3>
          <div className="space-y-4">
            {Object.entries(magicPrompt.perApp || {}).map(([app, count]) => (
              <div
                key={app}
                className="flex justify-between items-center p-3 bg-purple-50 rounded-lg"
              >
                <span className="font-medium capitalize">{app.replace('-', ' ')}</span>
                <span className="text-lg font-bold text-purple-600">
                  {new Intl.NumberFormat().format(count)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Token Efficiency */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">
          {t('admin.usage.sections.tokenEfficiency', 'Token Efficiency')}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <h4 className="font-medium text-gray-700 mb-3">
              {t('admin.usage.sections.inputTokenDistribution', 'Input Token Distribution')}
            </h4>
            <div className="space-y-3">
              {Object.entries(magicPrompt.tokensIn.perUser || {}).map(([user, tokens]) => {
                const maxTokens = Math.max(...Object.values(magicPrompt.tokensIn.perUser || {}));
                const percentage = maxTokens > 0 ? (tokens / maxTokens) * 100 : 0;

                return (
                  <div key={user} className="space-y-1">
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-600 truncate">{user.replace('session-', '')}</span>
                      <span className="font-medium">{new Intl.NumberFormat().format(tokens)}</span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-2">
                      <div
                        className="bg-blue-500 h-2 rounded-full transition-all duration-300"
                        style={{ width: `${percentage}%` }}
                      ></div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <h4 className="font-medium text-gray-700 mb-3">
              {t('admin.usage.sections.outputTokenDistribution', 'Output Token Distribution')}
            </h4>
            <div className="space-y-3">
              {Object.entries(magicPrompt.tokensOut.perUser || {}).map(([user, tokens]) => {
                const maxTokens = Math.max(...Object.values(magicPrompt.tokensOut.perUser || {}));
                const percentage = maxTokens > 0 ? (tokens / maxTokens) * 100 : 0;

                return (
                  <div key={user} className="space-y-1">
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-600 truncate">{user.replace('session-', '')}</span>
                      <span className="font-medium">{new Intl.NumberFormat().format(tokens)}</span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-2">
                      <div
                        className="bg-green-500 h-2 rounded-full transition-all duration-300"
                        style={{ width: `${percentage}%` }}
                      ></div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  const renderFeedback = () => (
    <div className="space-y-6">
      {/* Feedback Overview */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <FeedbackCard data={feedback} />

        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">
            {t('admin.usage.sections.userFeedbackActivity', 'User Feedback Activity')}
          </h3>
          <div className="space-y-4">
            {Object.entries(feedback.perUser || {}).map(([user, userFeedback]) => {
              const totalUserFeedback = (userFeedback.good || 0) + (userFeedback.bad || 0);
              const userGoodPercentage =
                totalUserFeedback > 0 ? ((userFeedback.good || 0) / totalUserFeedback) * 100 : 0;

              return (
                <div key={user} className="p-3 bg-gray-50 rounded-lg">
                  <div className="flex justify-between items-center mb-2">
                    <span className="font-medium text-gray-900 truncate">
                      {user.replace('session-', '')}
                    </span>
                    <span className="text-sm text-gray-600">{totalUserFeedback} responses</span>
                  </div>
                  <div className="flex items-center space-x-4 text-sm">
                    <div className="flex items-center space-x-1">
                      <div className="w-3 h-3 bg-green-500 rounded-full"></div>
                      <span>{userFeedback.good || 0}</span>
                    </div>
                    <div className="flex items-center space-x-1">
                      <div className="w-3 h-3 bg-red-500 rounded-full"></div>
                      <span>{userFeedback.bad || 0}</span>
                    </div>
                    <div className="text-gray-600">{userGoodPercentage.toFixed(1)}% positive</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* App Feedback Breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">
            {t('admin.usage.sections.feedbackByApplication', 'Feedback by Application')}
          </h3>
          <div className="space-y-4">
            {Object.entries(feedback.perApp || {}).map(([app, appFeedback]) => {
              const totalAppFeedback = (appFeedback.good || 0) + (appFeedback.bad || 0);
              const appGoodPercentage =
                totalAppFeedback > 0 ? ((appFeedback.good || 0) / totalAppFeedback) * 100 : 0;

              return (
                <div key={app} className="space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="font-medium capitalize">{app.replace('-', ' ')}</span>
                    <span className="text-sm text-gray-600">{totalAppFeedback} responses</span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-3 overflow-hidden">
                    <div className="h-full flex">
                      <div
                        className="bg-green-500"
                        style={{ width: `${appGoodPercentage}%` }}
                      ></div>
                      <div
                        className="bg-red-500"
                        style={{ width: `${100 - appGoodPercentage}%` }}
                      ></div>
                    </div>
                  </div>
                  <div className="flex justify-between text-xs text-gray-600">
                    <span>👍 {appFeedback.good || 0}</span>
                    <span>{appGoodPercentage.toFixed(1)}% positive</span>
                    <span>👎 {appFeedback.bad || 0}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">
            {t('admin.usage.sections.feedbackByModel', 'Feedback by Model')}
          </h3>
          <div className="space-y-4">
            {Object.entries(feedback.perModel || {}).map(([model, modelFeedback]) => {
              const totalModelFeedback = (modelFeedback.good || 0) + (modelFeedback.bad || 0);
              const modelGoodPercentage =
                totalModelFeedback > 0 ? ((modelFeedback.good || 0) / totalModelFeedback) * 100 : 0;

              return (
                <div key={model} className="p-4 border rounded-lg">
                  <div className="flex justify-between items-center mb-3">
                    <span className="font-medium">{model}</span>
                    <span className="text-sm text-gray-600">{totalModelFeedback} responses</span>
                  </div>
                  <div className="grid grid-cols-2 gap-4 text-center">
                    <div className="p-2 bg-green-50 rounded">
                      <div className="text-lg font-bold text-green-600">
                        {modelFeedback.good || 0}
                      </div>
                      <div className="text-xs text-green-600">
                        {t('admin.dashboard.positive', 'Positive')}
                      </div>
                    </div>
                    <div className="p-2 bg-red-50 rounded">
                      <div className="text-lg font-bold text-red-600">{modelFeedback.bad || 0}</div>
                      <div className="text-xs text-red-600">
                        {t('admin.dashboard.negative', 'Negative')}
                      </div>
                    </div>
                  </div>
                  <div className="mt-2 text-center text-sm text-gray-600">
                    {modelGoodPercentage.toFixed(1)}% satisfaction rate
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );

  const renderDetails = () => (
    <div className="space-y-6">
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Model Usage Details</h3>
        <div className="space-y-4">
          {Object.entries(messages.perModel || {}).map(([model, messageCount]) => {
            const tokenCount = tokens.perModel[model] || 0;
            const promptTokens = tokens.prompt.perModel[model] || 0;
            const completionTokens = tokens.completion.perModel[model] || 0;
            const avgTokensPerMessage =
              messageCount > 0 ? Math.round(tokenCount / messageCount) : 0;

            return (
              <div key={model} className="p-4 border rounded-lg bg-gray-50">
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <h4 className="font-semibold text-lg text-gray-900">{model}</h4>
                    <p className="text-sm text-gray-600">AI Model</p>
                  </div>
                  <div className="text-right">
                    <div className="text-2xl font-bold text-blue-600">{messageCount}</div>
                    <div className="text-sm text-gray-600">messages</div>
                  </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="text-center p-3 bg-white rounded-lg">
                    <div className="text-lg font-bold text-gray-900">
                      {new Intl.NumberFormat().format(tokenCount)}
                    </div>
                    <div className="text-xs text-gray-600">Total Tokens</div>
                  </div>
                  <div className="text-center p-3 bg-blue-50 rounded-lg">
                    <div className="text-lg font-bold text-blue-600">
                      {new Intl.NumberFormat().format(promptTokens)}
                    </div>
                    <div className="text-xs text-blue-600">Prompt Tokens</div>
                  </div>
                  <div className="text-center p-3 bg-green-50 rounded-lg">
                    <div className="text-lg font-bold text-green-600">
                      {new Intl.NumberFormat().format(completionTokens)}
                    </div>
                    <div className="text-xs text-green-600">Completion Tokens</div>
                  </div>
                  <div className="text-center p-3 bg-amber-50 rounded-lg">
                    <div className="text-lg font-bold text-amber-600">{avgTokensPerMessage}</div>
                    <div className="text-xs text-amber-600">Avg/Message</div>
                  </div>
                </div>

                {/* Token Distribution Visual */}
                <div className="mt-4">
                  <div className="flex justify-between text-sm text-gray-600 mb-1">
                    <span>Token Distribution</span>
                    <span>
                      {tokenCount > 0 ? ((promptTokens / tokenCount) * 100).toFixed(1) : 0}% prompt
                      / {tokenCount > 0 ? ((completionTokens / tokenCount) * 100).toFixed(1) : 0}%
                      completion
                    </span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-3 overflow-hidden">
                    <div className="h-full flex">
                      <div
                        className="bg-blue-500"
                        style={{
                          width: tokenCount > 0 ? `${(promptTokens / tokenCount) * 100}%` : '0%'
                        }}
                      ></div>
                      <div
                        className="bg-green-500"
                        style={{
                          width: tokenCount > 0 ? `${(completionTokens / tokenCount) * 100}%` : '0%'
                        }}
                      ></div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* System Overview */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">
          {t('admin.usage.overview.systemOverview', 'System Overview')}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="text-center p-4 bg-blue-50 rounded-lg">
            <div className="text-2xl font-bold text-blue-600">
              {Object.keys(messages.perUser || {}).length}
            </div>
            <div className="text-sm text-blue-600 font-medium">
              {t('admin.usage.overview.activeUsers', 'Active Users')}
            </div>
          </div>
          <div className="text-center p-4 bg-green-50 rounded-lg">
            <div className="text-2xl font-bold text-green-600">
              {Object.keys(messages.perApp || {}).length}
            </div>
            <div className="text-sm text-green-600 font-medium">
              {t('admin.usage.overview.activeApps', 'Active Apps')}
            </div>
          </div>
          <div className="text-center p-4 bg-purple-50 rounded-lg">
            <div className="text-2xl font-bold text-purple-600">
              {Object.keys(messages.perModel || {}).length}
            </div>
            <div className="text-sm text-purple-600 font-medium">
              {t('admin.usage.overview.modelsUsed', 'Models Used')}
            </div>
          </div>
          <div className="text-center p-4 bg-amber-50 rounded-lg">
            <div className="text-2xl font-bold text-amber-600">
              {messages.total > 0 ? Math.round(tokens.total / messages.total) : 0}
            </div>
            <div className="text-sm text-amber-600 font-medium">
              {t('admin.usage.overview.avgTokensPerMsg', 'Avg Tokens/Msg')}
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <AdminAuth>
      <AdminNavigation />
      <div className="min-h-screen bg-gray-50">
        {/* Header */}
        <div className="bg-white shadow-sm border-b border-gray-200">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex justify-between items-center py-6">
              <div>
                <h1 className="text-3xl font-bold text-gray-900">
                  {t('admin.usage.title', 'Admin Dashboard')}
                </h1>
                <p className="text-gray-600 mt-1">
                  {t('admin.usage.subtitle', 'Usage analytics and system overview')}
                </p>
              </div>
              <div className="flex space-x-3">
                <button
                  onClick={downloadCsv}
                  className="inline-flex items-center px-4 py-2 bg-white border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                >
                  {t('admin.usage.downloadCsv', 'Download CSV')}
                </button>
                <button
                  onClick={downloadJson}
                  className="inline-flex items-center px-4 py-2 bg-indigo-600 border border-transparent rounded-md shadow-sm text-sm font-medium text-white hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                >
                  {t('admin.usage.downloadJson', 'Download JSON')}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Stats Bar */}
        <div className="bg-white border-b border-gray-200">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
              <div>
                <div className="text-sm text-gray-600">
                  {t('admin.usage.lastUpdated', 'Last Updated')}
                </div>
                <div className="text-sm font-medium">{new Date(lastUpdated).toLocaleString()}</div>
              </div>
              <div>
                <div className="text-sm text-gray-600">
                  {t('admin.usage.lastReset', 'Last Reset')}
                </div>
                <div className="text-sm font-medium">{new Date(lastReset).toLocaleString()}</div>
              </div>
              <div>
                <div className="text-sm text-gray-600">
                  {t('admin.usage.activeUsers', 'Active Users')}
                </div>
                <div className="text-sm font-medium">
                  {Object.keys(messages.perUser || {}).length}
                </div>
              </div>
              <div>
                <div className="text-sm text-gray-600">
                  {t('admin.usage.activeApps', 'Active Apps')}
                </div>
                <div className="text-sm font-medium">
                  {Object.keys(messages.perApp || {}).length}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="bg-white border-b border-gray-200">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <nav className="-mb-px flex space-x-8">
              {tabs.map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`inline-flex items-center space-x-2 py-4 px-1 border-b-2 font-medium text-sm ${
                    activeTab === tab.id
                      ? 'border-indigo-500 text-indigo-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  {tab.icon}
                  <span>{tab.label}</span>
                </button>
              ))}
            </nav>
          </div>
        </div>

        {/* Content */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {activeTab === 'overview' && renderOverview()}
          {activeTab === 'users' && renderUsers()}
          {activeTab === 'apps' && renderApps()}
          {activeTab === 'magic' && renderMagic()}
          {activeTab === 'feedback' && renderFeedback()}
          {activeTab === 'details' && renderDetails()}
        </div>
      </div>
    </AdminAuth>
  );
};

export default AdminUsageReports;
