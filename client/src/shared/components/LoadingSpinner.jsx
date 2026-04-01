export default function LoadingSpinner({ message = 'Loading...' }) {
  return (
    <div
      className="flex flex-col items-center justify-center py-12"
      role="status"
      aria-live="polite"
    >
      <div
        className="w-12 h-12 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin mb-4"
        aria-hidden="true"
      ></div>
      <p className="text-gray-700">{message}</p>
    </div>
  );
}
