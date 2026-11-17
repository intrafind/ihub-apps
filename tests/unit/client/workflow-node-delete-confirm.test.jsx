// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Workflow editor (opened from Admin → Workflows): deleting a node asks in a
 * named ConfirmDialog, never in a native window.confirm().
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('../../../client/src/features/workflows/editor/panels/forms/index', () => ({
  nodeFormRegistry: {}
}));
jest.mock('../../../client/src/features/workflows/editor/panels/VariablesPanel', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/workflows/editor/panels/NodeConnections', () => ({
  NodeConnections: () => null
}));
jest.mock('../../../client/src/features/workflows/editor/nodes/nodeIcons', () => ({
  NodeTypeIcon: () => null
}));
jest.mock('react-i18next', () => {
  const { enT } = require('./helpers/i18nMock');
  const translation = { t: enT, i18n: { language: 'en' } };
  return { useTranslation: () => translation };
});

const {
  NodeConfigPanel
} = require('../../../client/src/features/workflows/editor/panels/NodeConfigPanel');

const NODE = {
  id: 'n1',
  data: { nodeType: 'agent', nodeName: 'Summarize', nodeConfig: {} }
};

function renderPanel(onDeleteNode) {
  return render(
    <NodeConfigPanel
      selectedNode={NODE}
      variables={[]}
      onUpdateNode={jest.fn()}
      onClose={jest.fn()}
      onDeleteNode={onDeleteNode}
    />
  );
}

test('deleting a node asks in a named dialog and deletes only on confirm', () => {
  const confirmSpy = jest.spyOn(window, 'confirm').mockImplementation(() => true);
  const onDeleteNode = jest.fn();
  renderPanel(onDeleteNode);

  fireEvent.click(screen.getByRole('button', { name: 'Delete node' }));
  const dialog = screen.getByRole('alertdialog', { name: 'Delete node "Summarize"?' });
  expect(onDeleteNode).not.toHaveBeenCalled();
  expect(confirmSpy).not.toHaveBeenCalled();

  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete node' }));
  expect(onDeleteNode).toHaveBeenCalledWith('n1');
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  confirmSpy.mockRestore();
});

test('cancelling the node-delete dialog keeps the node', () => {
  const onDeleteNode = jest.fn();
  renderPanel(onDeleteNode);

  fireEvent.click(screen.getByRole('button', { name: 'Delete node' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onDeleteNode).not.toHaveBeenCalled();
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
});
