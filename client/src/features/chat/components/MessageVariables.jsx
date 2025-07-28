

/**
 * A component to display message variables such as target language or other metadata
 */
const MessageVariables = ({ variables }) => {

  if (!variables || Object.keys(variables).length === 0) {
    return null;
  }

  return (
    <div className="mt-2 pt-2 border-t border-gray-200 dark:border-gray-700">
      <div className="text-xs text-gray-500 dark:text-gray-400">
        {Object.entries(variables).map(([key, value]) => (
          <div key={key} className="inline-block mr-3">
            <span className="font-medium">{key}:</span> {value}
          </div>
        ))}
      </div>
    </div>
  );
};

export default MessageVariables;
