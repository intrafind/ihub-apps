import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchAdminFeedbackEntries } from '../../../../api/adminApi';
import LoadingSpinner from '../../../../shared/components/LoadingSpinner';

/**
 * Feedback review UI — the rating overview, the per-user/app/model breakdowns
 * and the individual entries with their comments.
 *
 * Lives here rather than in a page because Admin → Feedback is the one place
 * that shows feedback; the usage report links to it instead of repeating it.
 */

function FeedbackCard({ data }) {
  const { t } = useTranslation();

  // New star rating data (merge with legacy feedback)
  const starRatings = { ...(data.ratings || {}) };

  // Map legacy feedback: good -> 5 stars, bad -> 1 star
  const legacyGood = data.good || 0;
  const legacyBad = data.bad || 0;

  if (legacyGood > 0) {
    starRatings[5] = (starRatings[5] || 0) + legacyGood;
  }
  if (legacyBad > 0) {
    starRatings[1] = (starRatings[1] || 0) + legacyBad;
  }

  // Calculate total and average including legacy data
  const totalStarRatings = Object.values(starRatings).reduce((sum, count) => sum + count, 0);
  const weightedSum = Object.entries(starRatings).reduce(
    (sum, [rating, count]) => sum + parseInt(rating) * count,
    0
  );
  const averageRating = totalStarRatings > 0 ? weightedSum / totalStarRatings : 0;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700 p-6">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
        {t('admin.dashboard.feedbackOverview', 'Feedback Overview')}
      </h3>

      {totalStarRatings > 0 ? (
        <div className="p-4 bg-amber-50 dark:bg-amber-900/30 rounded-lg">
          <div className="flex items-center justify-center space-x-2 mb-3">
            <div className="flex items-center">
              {[1, 2, 3, 4, 5].map(star => (
                <svg
                  key={star}
                  className={`w-6 h-6 ${
                    star <= Math.round(averageRating)
                      ? 'text-yellow-400'
                      : 'text-gray-300 dark:text-gray-600'
                  }`}
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                </svg>
              ))}
            </div>
            <span className="text-2xl font-bold text-amber-600 dark:text-amber-400">
              {averageRating.toFixed(1)}
            </span>
          </div>
          <div className="text-center">
            <div className="text-sm text-amber-600 dark:text-amber-400 font-medium">
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
                  <span className="w-8 text-gray-600 dark:text-gray-400">{star}★</span>
                  <div className="flex-1 bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                    <div
                      className="bg-yellow-400 h-2 rounded-full transition-all duration-300"
                      style={{ width: `${percentage}%` }}
                    />
                  </div>
                  <span className="w-8 text-gray-600 dark:text-gray-400 text-xs">{count}</span>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="text-center p-8 text-gray-500 dark:text-gray-400">
          <svg
            className="w-12 h-12 mx-auto mb-4 text-gray-300 dark:text-gray-600"
            fill="currentColor"
            viewBox="0 0 20 20"
          >
            <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
          </svg>
          <div className="text-lg font-medium mb-2">No feedback available</div>
          <div className="text-sm">No user ratings have been submitted yet.</div>
        </div>
      )}

      <div className="text-center text-sm text-gray-600 dark:text-gray-400 mt-4">
        Total feedback: {totalStarRatings} responses
      </div>
    </div>
  );
}

function FeedbackEntriesCard() {
  const { t } = useTranslation();
  const [feedbackData, setFeedbackData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const pageSize = 20;

  useEffect(() => {
    loadFeedback();
  }, [page]);

  const loadFeedback = async () => {
    try {
      setLoading(true);
      const data = await fetchAdminFeedbackEntries(pageSize, page * pageSize);
      setFeedbackData(data);
    } catch (e) {
      console.error('Failed to load feedback entries', e);
    } finally {
      setLoading(false);
    }
  };

  const formatDate = timestamp => {
    return new Date(timestamp).toLocaleString();
  };

  const renderStars = rating => {
    return (
      <div className="flex items-center">
        {[1, 2, 3, 4, 5].map(star => (
          <svg
            key={star}
            className={`w-4 h-4 ${
              star <= Math.round(rating) ? 'text-yellow-400' : 'text-gray-300 dark:text-gray-600'
            }`}
            fill="currentColor"
            viewBox="0 0 20 20"
          >
            <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
          </svg>
        ))}
        <span className="ml-2 text-sm text-gray-600 dark:text-gray-400">{rating.toFixed(1)}</span>
      </div>
    );
  };

  if (loading && !feedbackData) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700 p-6">
        <LoadingSpinner />
      </div>
    );
  }

  const { feedbackEntries = [], total = 0 } = feedbackData || {};
  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700 p-6">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('admin.usage.feedbackEntries', 'User Feedback Entries')}
        </h3>
        <span className="text-sm text-gray-600 dark:text-gray-400">
          {total} {t('admin.usage.totalEntries', 'total entries')}
        </span>
      </div>

      {feedbackEntries.length === 0 ? (
        <div className="text-center p-8 text-gray-500 dark:text-gray-400">
          <div className="text-lg font-medium mb-2">
            {t('admin.usage.noFeedback', 'No feedback available')}
          </div>
          <div className="text-sm">
            {t('admin.usage.noFeedbackDesc', 'No user feedback has been submitted yet.')}
          </div>
        </div>
      ) : (
        <>
          <div className="space-y-4">
            {feedbackEntries.map((entry, index) => (
              <div
                key={index}
                className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-700"
              >
                <div className="flex justify-between items-start mb-2">
                  <div className="flex-1">
                    {renderStars(entry.rating)}
                    <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      {formatDate(entry.timestamp)}
                    </div>
                  </div>
                  <div className="text-right text-xs text-gray-500 dark:text-gray-400 space-y-1">
                    {entry.userId && <div>User: {entry.userId}</div>}
                    {entry.appId && <div>App: {entry.appId}</div>}
                    {entry.modelId && <div>Model: {entry.modelId}</div>}
                  </div>
                </div>
                {entry.comment && entry.comment.trim() && (
                  <div className="mt-3 p-3 bg-white dark:bg-gray-600 rounded-sm border border-gray-200 dark:border-gray-500">
                    <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">
                      {t('admin.usage.feedbackComment', 'Comment')}:
                    </div>
                    <div className="text-sm text-gray-900 dark:text-gray-100 whitespace-pre-wrap">
                      {entry.comment}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex justify-center items-center space-x-2 mt-6 pt-4 border-t border-gray-200 dark:border-gray-700">
              <button
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0}
                className="px-3 py-1 rounded-sm border border-gray-300 dark:border-gray-600 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                {t('admin.usage.previous', 'Previous')}
              </button>
              <span className="text-sm text-gray-600 dark:text-gray-400">
                {t('admin.usage.pageInfo', `Page ${page + 1} of ${totalPages}`)}
              </span>
              <button
                onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                className="px-3 py-1 rounded-sm border border-gray-300 dark:border-gray-600 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                {t('admin.usage.next', 'Next')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The full review: overview, breakdowns and entries.
 *
 * @param {Object} props
 * @param {Object} props.feedback - The `feedback` section of the usage summary
 */
export function FeedbackReview({ feedback }) {
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
      {/* Feedback Overview */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <FeedbackCard data={feedback} />

        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            {t('admin.usage.sections.userFeedbackActivity', 'User Feedback Activity')}
          </h3>
          <div className="space-y-4">
            {Object.entries(feedback.perUser || {}).map(([user, userFeedback]) => {
              const totalUserFeedback = userFeedback.total || 0;
              const averageRating = userFeedback.averageRating || 0;

              return (
                <div key={user} className="p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                  <div className="flex justify-between items-center mb-2">
                    <span className="font-medium text-gray-900 dark:text-gray-100 truncate">
                      {user.replace('session-', '')}
                    </span>
                    <span className="text-sm text-gray-600 dark:text-gray-400">
                      {totalUserFeedback} responses
                    </span>
                  </div>
                  {totalUserFeedback > 0 && (
                    <div className="flex items-center space-x-2 text-sm">
                      <div className="flex items-center">
                        {[1, 2, 3, 4, 5].map(star => (
                          <svg
                            key={star}
                            className={`w-3 h-3 ${
                              star <= Math.round(averageRating)
                                ? 'text-yellow-400'
                                : 'text-gray-300 dark:text-gray-600'
                            }`}
                            fill="currentColor"
                            viewBox="0 0 20 20"
                          >
                            <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                          </svg>
                        ))}
                      </div>
                      <span className="text-amber-600 dark:text-amber-400 font-medium">
                        {averageRating.toFixed(1)}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* App Feedback Breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            {t('admin.usage.sections.feedbackByApplication', 'Feedback by Application')}
          </h3>
          <div className="space-y-4">
            {Object.entries(feedback.perApp || {}).map(([app, appFeedback]) => {
              const totalAppFeedback = appFeedback.total || 0;
              const averageRating = appFeedback.averageRating || 0;

              return (
                <div key={app} className="p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                  <div className="flex justify-between items-center mb-2">
                    <span className="font-medium text-gray-900 dark:text-gray-100 capitalize">
                      {app.replace('-', ' ')}
                    </span>
                    <span className="text-sm text-gray-600 dark:text-gray-400">
                      {totalAppFeedback} responses
                    </span>
                  </div>
                  {totalAppFeedback > 0 && (
                    <div className="flex items-center space-x-2 text-sm">
                      <div className="flex items-center">
                        {[1, 2, 3, 4, 5].map(star => (
                          <svg
                            key={star}
                            className={`w-3 h-3 ${
                              star <= Math.round(averageRating)
                                ? 'text-yellow-400'
                                : 'text-gray-300 dark:text-gray-600'
                            }`}
                            fill="currentColor"
                            viewBox="0 0 20 20"
                          >
                            <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                          </svg>
                        ))}
                      </div>
                      <span className="text-amber-600 dark:text-amber-400 font-medium">
                        {averageRating.toFixed(1)}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            {t('admin.usage.sections.feedbackByModel', 'Feedback by Model')}
          </h3>
          <div className="space-y-4">
            {Object.entries(feedback.perModel || {}).map(([model, modelFeedback]) => {
              const totalModelFeedback = modelFeedback.total || 0;
              const averageRating = modelFeedback.averageRating || 0;

              return (
                <div key={model} className="p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                  <div className="flex justify-between items-center mb-2">
                    <span className="font-medium text-gray-900 dark:text-gray-100">{model}</span>
                    <span className="text-sm text-gray-600 dark:text-gray-400">
                      {totalModelFeedback} responses
                    </span>
                  </div>
                  {totalModelFeedback > 0 && (
                    <div className="flex items-center space-x-2 text-sm">
                      <div className="flex items-center">
                        {[1, 2, 3, 4, 5].map(star => (
                          <svg
                            key={star}
                            className={`w-3 h-3 ${
                              star <= Math.round(averageRating)
                                ? 'text-yellow-400'
                                : 'text-gray-300 dark:text-gray-600'
                            }`}
                            fill="currentColor"
                            viewBox="0 0 20 20"
                          >
                            <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                          </svg>
                        ))}
                      </div>
                      <span className="text-amber-600 dark:text-amber-400 font-medium">
                        {averageRating.toFixed(1)}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Individual Feedback Entries with Comments */}
      <FeedbackEntriesCard />
    </div>
  );
}

export default FeedbackReview;
