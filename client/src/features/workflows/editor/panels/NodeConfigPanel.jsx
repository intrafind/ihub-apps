import { useState, useEffect } from 'react';

/**
 * Side panel for editing the selected workflow node's name and JSON configuration.
 * Validates JSON before applying changes. Appears on the right side of the editor
 * when a node is selected.
 *
 * @param {object} props
 * @param {object} props.selectedNode - The currently selected React Flow node
 * @param {function} props.onUpdateNode - Callback to update node data: (nodeId, { nodeName, nodeConfig }) => void
 * @param {function} props.onClose - Callback to close the panel
 */
export function NodeConfigPanel({ selectedNode, onUpdateNode, onClose }) {
  const [name, setName] = useState('');
  const [configText, setConfigText] = useState('');
  const [parseError, setParseError] = useState(null);

  useEffect(() => {
    if (selectedNode) {
      setName(selectedNode.data.nodeName || '');
      setConfigText(JSON.stringify(selectedNode.data.nodeConfig || {}, null, 2));
      setParseError(null);
    }
  }, [selectedNode?.id]);

  if (!selectedNode) return null;

  /** Validates the JSON config and applies changes to the node */
  const handleApply = () => {
    try {
      const parsed = JSON.parse(configText);
      setParseError(null);
      onUpdateNode(selectedNode.id, {
        nodeName: name,
        nodeConfig: parsed
      });
    } catch (e) {
      setParseError(e.message);
    }
  };

  return (
    <div className="w-80 border-l border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 overflow-y-auto">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          Node Configuration
        </h3>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          aria-label="Close panel"
        >
          &#x2715;
        </button>
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
            Type
          </label>
          <div className="text-sm text-gray-900 dark:text-gray-100 font-mono bg-gray-50 dark:bg-gray-900 px-2 py-1 rounded">
            {selectedNode.data.nodeType}
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
            Name
          </label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
            placeholder="Node name"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
            Config (JSON)
          </label>
          <textarea
            value={configText}
            onChange={e => {
              setConfigText(e.target.value);
              setParseError(null);
            }}
            rows={12}
            className="w-full text-xs font-mono border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
          />
          {parseError && <p className="text-xs text-red-500 mt-1">{parseError}</p>}
        </div>

        <button
          onClick={handleApply}
          className="w-full bg-blue-600 text-white text-sm py-2 rounded hover:bg-blue-700 transition-colors"
        >
          Apply Changes
        </button>
      </div>
    </div>
  );
}

export default NodeConfigPanel;
