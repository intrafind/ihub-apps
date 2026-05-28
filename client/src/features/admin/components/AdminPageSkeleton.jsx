/**
 * Animated skeleton loader for admin list pages.
 * Replaces full-page spinners while data loads.
 *
 * @param {Object} props
 * @param {number} [props.rows=5] Number of skeleton rows to show
 * @param {boolean} [props.hasHeader=true] Whether to show a header skeleton
 */
function AdminPageSkeleton({ rows = 5, hasHeader = true }) {
  return (
    <div className="animate-pulse" aria-hidden="true">
      {hasHeader && (
        <div className="mb-6 flex items-center justify-between">
          <div>
            <div className="h-7 w-48 bg-gray-200 dark:bg-gray-700 rounded-md" />
            <div className="mt-2 h-4 w-72 bg-gray-200 dark:bg-gray-700 rounded-md" />
          </div>
          <div className="h-9 w-28 bg-gray-200 dark:bg-gray-700 rounded-lg" />
        </div>
      )}

      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
        {/* Table header */}
        <div className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50 px-6 py-3 flex gap-6">
          <div className="h-3 w-24 bg-gray-200 dark:bg-gray-700 rounded" />
          <div className="h-3 w-32 bg-gray-200 dark:bg-gray-700 rounded" />
          <div className="h-3 w-20 bg-gray-200 dark:bg-gray-700 rounded ml-auto" />
        </div>

        {/* Rows */}
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            className="px-6 py-4 flex items-center gap-4 border-b border-gray-100 dark:border-gray-700/50 last:border-0"
          >
            <div className="h-4 w-4 bg-gray-200 dark:bg-gray-700 rounded" />
            <div className="flex-1 space-y-2">
              <div
                className="h-4 bg-gray-200 dark:bg-gray-700 rounded"
                style={{ width: `${45 + (i % 3) * 15}%` }}
              />
              <div
                className="h-3 bg-gray-100 dark:bg-gray-700/60 rounded"
                style={{ width: `${25 + (i % 4) * 10}%` }}
              />
            </div>
            <div className="h-6 w-16 bg-gray-200 dark:bg-gray-700 rounded-full" />
            <div className="h-8 w-8 bg-gray-200 dark:bg-gray-700 rounded" />
            <div className="h-8 w-8 bg-gray-200 dark:bg-gray-700 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}

export default AdminPageSkeleton;
