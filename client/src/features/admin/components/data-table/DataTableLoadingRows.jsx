function DataTableLoadingRows({ rows = 5, columnCount }) {
  // Skeleton rows have no identity beyond their position — disabling the
  // array-index-key rule is intentional here.
  /* eslint-disable @eslint-react/no-array-index-key */
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <tr key={i} className="animate-pulse">
          {Array.from({ length: columnCount }).map((__, j) => (
            <td key={j} className="px-4 py-3">
              <div
                className="h-3 bg-gray-200 dark:bg-gray-700 rounded"
                style={{ width: `${40 + ((i + j) % 4) * 15}%` }}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
  /* eslint-enable @eslint-react/no-array-index-key */
}

export default DataTableLoadingRows;
