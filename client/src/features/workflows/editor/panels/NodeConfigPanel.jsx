import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { nodeFormRegistry } from './forms/index';
import { NODE_TYPE_COLORS } from '../workflowEditorUtils';

/**
 * Side panel for editing the selected workflow node's configuration.
 * Provides both a structured form view (via nodeFormRegistry) and a raw JSON editor,
 * switchable via tabs. Includes node deletion for non-start/end nodes.
 *
 * @param {object} props
 * @param {object} props.selectedNode - The currently selected React Flow node
 * @param {function} props.onUpdateNode - Callback to update node data: (nodeId, { nodeName, nodeConfig }) => void
 * @param {function} props.onClose - Callback to close the panel
 * @param {function} props.onDeleteNode - Callback to delete a node: (nodeId) => void
 */
export function NodeConfigPanel({ selectedNode, onUpdateNode, onClose, onDeleteNode }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [config, setConfig] = useState({});
  const [configText, setConfigText] = useState('');
  const [activeTab, setActiveTab] = useState('form');
  const [parseError, setParseError] = useState(null);

  useEffect(() => {
    if (selectedNode) {
      setName(selectedNode.data.nodeName || '');
      const nodeConfig = selectedNode.data.nodeConfig || {};
      setConfig(nodeConfig);
      setConfigText(JSON.stringify(nodeConfig, null, 2));
      setActiveTab('form');
      setParseError(null);
    }
  }, [selectedNode?.id]);

  if (!selectedNode) return null;

  const nodeType = selectedNode.data.nodeType;
  const FormComponent = nodeFormRegistry[nodeType];

  /**
   * Handles switching between form and JSON tabs.
   * Syncs data between the two representations on switch.
   * @param {'form' | 'json'} tab - The tab to switch to
   */
  const handleTabSwitch = tab => {
    if (tab === 'json') {
      setConfigText(JSON.stringify(config, null, 2));
    } else if (tab === 'form') {
      try {
        const parsed = JSON.parse(configText);
        setConfig(parsed);
        setParseError(null);
      } catch (e) {
        setParseError(e.message);
        return;
      }
    }
    setActiveTab(tab);
  };

  const handleConfigChange = newConfig => {
    setConfig(newConfig);
  };

  /** Validates and applies changes to the node */
  const handleApply = () => {
    let finalConfig = config;
    if (activeTab === 'json') {
      try {
        finalConfig = JSON.parse(configText);
        setParseError(null);
        setConfig(finalConfig);
      } catch (e) {
        setParseError(e.message);
        return;
      }
    }
    onUpdateNode(selectedNode.id, {
      nodeName: name,
      nodeConfig: finalConfig
    });
  };

  const handleDelete = () => {
    if (
      onDeleteNode &&
      window.confirm(t('workflows.editor.confirmDeleteNode', 'Delete this node?'))
    ) {
      onDeleteNode(selectedNode.id);
    }
  };

  return (
    <div className="w-80 border-l border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 overflow-y-auto">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span
            className="inline-block w-3 h-3 rounded-full"
            style={{ backgroundColor: NODE_TYPE_COLORS[nodeType] || '#6B7280' }}
            aria-hidden="true"
          />
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{nodeType}</span>
        </div>
        <div className="flex items-center gap-1">
          {nodeType !== 'start' && nodeType !== 'end' && onDeleteNode && (
            <button
              onClick={handleDelete}
              className="text-red-400 hover:text-red-600 p-1"
              aria-label={t('workflows.editor.deleteNode', 'Delete node')}
              title={t('workflows.editor.deleteNode', 'Delete node')}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="w-4 h-4"
                viewBox="0 0 20 20"
                fill="currentColor"
                aria-hidden="true"
              >
                <path
                  fillRule="evenodd"
                  d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          )}
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 p-1"
            aria-label={t('common.close', 'Close')}
          >
            &#x2715;
          </button>
        </div>
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
            {t('workflows.editor.name', 'Name')}
          </label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
            placeholder={t('workflows.editor.name', 'Name')}
          />
        </div>

        <div className="flex border-b border-gray-200 dark:border-gray-700">
          <button
            onClick={() => handleTabSwitch('form')}
            className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
              activeTab === 'form'
                ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400'
            }`}
          >
            {t('workflows.editor.formTab', 'Form')}
          </button>
          <button
            onClick={() => handleTabSwitch('json')}
            className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
              activeTab === 'json'
                ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400'
            }`}
          >
            {t('workflows.editor.jsonTab', 'JSON')}
          </button>
        </div>

        {activeTab === 'form' ? (
          FormComponent ? (
            <FormComponent config={config} onChange={handleConfigChange} />
          ) : (
            <div className="text-xs text-gray-500 dark:text-gray-400 italic">
              {t(
                'workflows.editor.noFormAvailable',
                'No form available for this node type. Use the JSON tab.'
              )}
            </div>
          )
        ) : (
          <div>
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
        )}

        <button
          onClick={handleApply}
          className="w-full bg-blue-600 text-white text-sm py-2 rounded hover:bg-blue-700 transition-colors"
        >
          {t('workflows.editor.applyChanges', 'Apply Changes')}
        </button>
      </div>
    </div>
  );
}

export default NodeConfigPanel;
