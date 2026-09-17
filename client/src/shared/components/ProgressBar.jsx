export default function ProgressBar({ value, max, label, variant = 'stacked' }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;

  if (variant === 'inline') {
    return (
      <div className="flex items-center gap-2">
        <div className="flex-1 bg-gray-200 dark:bg-gray-700 rounded-full h-2 overflow-hidden">
          <div
            className="bg-blue-600 h-2 rounded-full transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="text-xs text-gray-500 dark:text-gray-400 w-10 text-right">{pct}%</span>
      </div>
    );
  }

  return (
    <div className="w-full">
      {label && <div className="text-sm text-gray-600 dark:text-gray-400 mb-1">{label}</div>}
      <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-3 overflow-hidden">
        <div
          className="bg-blue-600 h-3 rounded-full transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 text-right">
        {value} / {max} ({pct}%)
      </div>
    </div>
  );
}
