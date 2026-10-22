// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NODE_TYPE_META } from '../workflowEditorUtils';

/** Display name of a node, matching the label shown on the canvas. */
function nodeLabel(node) {
  return node.data.nodeName || NODE_TYPE_META[node.data.nodeType]?.label || node.data.nodeType;
}

/**
 * Keyboard-operable alternative to dragging a connection between two handles on
 * the canvas: lists the selected node's outgoing connections and lets the user
 * add or remove them with plain form controls.
 *
 * Connections go through the editor's own `onConnect`, so the same rules apply
 * as for dragging (no crossing of a loop boundary, decision branches carry
 * their yes/no condition).
 *
 * @param {object} props
 * @param {object} props.node - The selected node
 * @param {object[]} props.nodes - All nodes in the workflow
 * @param {object[]} props.edges - All edges in the workflow
 * @param {function} props.onConnect - (params: { source, target, sourceHandle, targetHandle }) => void
 * @param {function} props.onDeleteEdge - (edgeId) => void
 * @param {function} [props.onEditEdge] - (edge) => void, opens the condition editor for an edge
 */
export function NodeConnections({ node, nodes, edges, onConnect, onDeleteEdge, onEditEdge }) {
  const { t } = useTranslation();
  const [targetId, setTargetId] = useState('');
  const [branch, setBranch] = useState('true');

  const nodeType = node.data.nodeType;
  const isDecision = nodeType === 'decision';
  const sourceHandle = isDecision ? branch : null;

  const byId = new Map(nodes.map(n => [n.id, n]));
  const outgoing = edges.filter(e => e.source === node.id);

  const branchLabel = handle =>
    handle === 'true'
      ? t('workflows.editor.connections.branchYes', 'Yes')
      : handle === 'false'
        ? t('workflows.editor.connections.branchNo', 'No')
        : null;

  // Start nodes take no input; a target can only be linked once per source handle.
  const targets = nodes.filter(
    n =>
      n.id !== node.id &&
      n.data.nodeType !== 'start' &&
      (n.parentId || null) === (node.parentId || null) &&
      !outgoing.some(e => e.target === n.id && (e.sourceHandle || null) === sourceHandle)
  );

  const handleAdd = () => {
    if (!targetId) return;
    onConnect({ source: node.id, target: targetId, sourceHandle, targetHandle: null });
    setTargetId('');
  };

  if (nodeType === 'end') return null;

  const selectClass =
    'w-full text-sm border border-gray-300 dark:border-gray-600 rounded-sm px-2 py-1.5 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100';

  return (
    <section
      aria-labelledby="node-connections-heading"
      className="pt-3 mt-3 border-t border-gray-200 dark:border-gray-700"
    >
      <h3
        id="node-connections-heading"
        className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1"
      >
        {t('workflows.editor.connections.title', 'Connections')}
      </h3>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
        {t(
          'workflows.editor.connections.help',
          'Choose which step runs next. This is the keyboard alternative to dragging a line between two steps on the canvas.'
        )}
      </p>

      {outgoing.length === 0 ? (
        <p className="text-xs text-gray-500 dark:text-gray-400 italic mb-2">
          {t('workflows.editor.connections.none', 'No outgoing connections yet.')}
        </p>
      ) : (
        <ul className="space-y-1 mb-3">
          {outgoing.map(edge => {
            const target = byId.get(edge.target);
            const name = target ? nodeLabel(target) : edge.target;
            const branchText = branchLabel(edge.sourceHandle);
            return (
              <li
                key={edge.id}
                className="flex items-center justify-between gap-2 text-sm text-gray-800 dark:text-gray-200"
              >
                <span className="truncate">
                  {branchText && (
                    <span className="font-semibold mr-1">
                      {t('workflows.editor.connections.branchPrefix', '{{branch}}:', {
                        branch: branchText
                      })}
                    </span>
                  )}
                  {name}
                </span>
                {onEditEdge && (
                  <button
                    type="button"
                    onClick={() => onEditEdge(edge)}
                    className="shrink-0 text-xs text-indigo-700 dark:text-indigo-300 hover:underline focus:outline-hidden focus:ring-2 focus:ring-indigo-500 rounded-sm px-1"
                    aria-label={t(
                      'workflows.editor.connections.editCondition',
                      'Edit condition of connection to {{name}}',
                      { name }
                    )}
                  >
                    {t('workflows.editor.connections.edit', 'Condition')}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onDeleteEdge(edge.id)}
                  className="shrink-0 text-xs text-red-700 dark:text-red-400 hover:underline focus:outline-hidden focus:ring-2 focus:ring-indigo-500 rounded-sm px-1"
                  aria-label={t(
                    'workflows.editor.connections.remove',
                    'Remove connection to {{name}}',
                    {
                      name
                    }
                  )}
                >
                  {t('workflows.editor.connections.removeButton', 'Remove')}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="space-y-2">
        {isDecision && (
          <div>
            <label
              htmlFor="node-connection-branch"
              className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1"
            >
              {t('workflows.editor.connections.branch', 'Branch')}
            </label>
            <select
              id="node-connection-branch"
              value={branch}
              onChange={e => {
                setBranch(e.target.value);
                setTargetId('');
              }}
              className={selectClass}
            >
              <option value="true">{t('workflows.editor.connections.branchYes', 'Yes')}</option>
              <option value="false">{t('workflows.editor.connections.branchNo', 'No')}</option>
            </select>
          </div>
        )}
        <div>
          <label
            htmlFor="node-connection-target"
            className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1"
          >
            {t('workflows.editor.connections.target', 'Connect to')}
          </label>
          <select
            id="node-connection-target"
            value={targetId}
            onChange={e => setTargetId(e.target.value)}
            className={selectClass}
          >
            <option value="">{t('workflows.editor.connections.choose', 'Choose a step…')}</option>
            {targets.map(n => (
              <option key={n.id} value={n.id}>
                {nodeLabel(n)}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={handleAdd}
          disabled={!targetId}
          className="px-3 py-1.5 text-xs font-medium rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
        >
          {t('workflows.editor.connections.add', 'Add connection')}
        </button>
      </div>
    </section>
  );
}

export default NodeConnections;
