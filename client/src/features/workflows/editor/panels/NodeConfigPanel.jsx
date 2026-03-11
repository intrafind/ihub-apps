import { useState, useEffect } from 'react';

function NodeConfigPanel({ node, onUpdate, onClose }) {
  const [label, setLabel] = useState('');
  const [configJson, setConfigJson] = useState('');
  const [parseError, setParseError] = useState(null);

  useEffect(() => {
    if (node) {
      setLabel(node.data.label || '');
      setConfigJson(JSON.stringify(node.data.nodeConfig || {}, null, 2));
      setParseError(null);
    }
  }, [node?.id]);

  if (!node) {
    return (
      <div className="w-72 border-l border-gray-200 dark:border-gray-700 p-4 flex items-center justify-center text-gray-400 text-sm">
        Select a node to configure
      </div>
    );
  }

  function handleSave() {
    try {
      const config = JSON.parse(configJson);
      setParseError(null);
      onUpdate(node.id, {
        ...node.data,
        label,
        nodeName: { en: label },
        nodeConfig: config
      });
    } catch (e) {
      setParseError(e.message);
    }
  }

  return (
    <div className="w-72 border-l border-gray-200 dark:border-gray-700 flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-gray-200 dark:border-gray-700">
        <span className="font-medium text-sm text-gray-800 dark:text-gray-200">Node Config</span>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 text-lg leading-none"
        >
          ×
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* Node name */}
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
            Name
          </label>
          <input
            type="text"
            value={label}
            onChange={e => setLabel(e.target.value)}
            className="w-full border border-gray-200 dark:border-gray-600 rounded px-2 py-1.5 text-sm bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* Config JSON */}
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
            Configuration (JSON)
          </label>
          <textarea
            value={configJson}
            onChange={e => {
              setConfigJson(e.target.value);
              setParseError(null);
            }}
            rows={12}
            className={`w-full border rounded px-2 py-1.5 text-xs font-mono bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none ${
              parseError ? 'border-red-400' : 'border-gray-200 dark:border-gray-600'
            }`}
          />
          {parseError && <p className="text-red-500 text-xs mt-1">{parseError}</p>}
        </div>
      </div>

      {/* Footer */}
      <div className="p-3 border-t border-gray-200 dark:border-gray-700">
        <button
          onClick={handleSave}
          className="w-full bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded px-3 py-1.5 transition-colors"
        >
          Apply Changes
        </button>
      </div>
    </div>
  );
}

export default NodeConfigPanel;
