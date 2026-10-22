import { render, screen, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom';

/**
 * NodeConnections — the keyboard-operable alternative to dragging a connection
 * between two handles on the workflow canvas.
 */
const mockT = (key, defaultValue, options) => {
  const text = typeof defaultValue === 'string' ? defaultValue : key;
  return options ? text.replace(/\{\{(\w+)\}\}/g, (_, name) => options[name] ?? '') : text;
};
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT, i18n: { language: 'en' } })
}));

const {
  NodeConnections
} = require('../../../client/src/features/workflows/editor/panels/NodeConnections');

const node = (id, nodeType, extra = {}) => ({
  id,
  data: { nodeType, nodeName: extra.nodeName || '' },
  ...extra.props
});

const NODES = [
  node('start', 'start'),
  node('a', 'prompt', { nodeName: 'Draft' }),
  node('b', 'prompt', { nodeName: 'Review' }),
  node('d', 'decision', { nodeName: 'Good enough?' }),
  node('end', 'end'),
  node('inner', 'prompt', { nodeName: 'Inside loop', props: { parentId: 'loop' } })
];

function setup(selected, edges = [], handlers = {}) {
  const props = {
    node: NODES.find(n => n.id === selected),
    nodes: NODES,
    edges,
    onConnect: jest.fn(),
    onDeleteEdge: jest.fn(),
    onEditEdge: jest.fn(),
    ...handlers
  };
  render(<NodeConnections {...props} />);
  return props;
}

const optionNames = select =>
  within(select)
    .getAllByRole('option')
    .map(o => o.textContent);

describe('NodeConnections', () => {
  it('connects the selected node to the chosen step with the keyboard-reachable controls', () => {
    const props = setup('a');

    fireEvent.change(screen.getByLabelText('Connect to'), { target: { value: 'b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add connection' }));

    expect(props.onConnect).toHaveBeenCalledWith({
      source: 'a',
      target: 'b',
      sourceHandle: null,
      targetHandle: null
    });
  });

  it('only offers valid targets: not itself, not start, not across a loop boundary', () => {
    setup('a');

    expect(optionNames(screen.getByLabelText('Connect to'))).toEqual([
      'Choose a step…',
      'Review',
      'Good enough?',
      'End'
    ]);
  });

  it('disables "Add connection" until a target is chosen', () => {
    setup('a');

    expect(screen.getByRole('button', { name: 'Add connection' })).toBeDisabled();
  });

  it('lets a decision node pick the yes/no branch and passes it as the source handle', () => {
    const props = setup('d');

    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'false' } });
    fireEvent.change(screen.getByLabelText('Connect to'), { target: { value: 'end' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add connection' }));

    expect(props.onConnect).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'd', target: 'end', sourceHandle: 'false' })
    );
  });

  it('lists existing connections and removes one by name', () => {
    const edges = [{ id: 'e1', source: 'a', target: 'b' }];
    const props = setup('a', edges);

    expect(screen.getByText('Review')).toBeInTheDocument();
    // A connection that already exists is not offered again.
    expect(optionNames(screen.getByLabelText('Connect to'))).not.toContain('Review');

    fireEvent.click(screen.getByRole('button', { name: 'Remove connection to Review' }));
    expect(props.onDeleteEdge).toHaveBeenCalledWith('e1');
  });

  it('opens the condition editor for a connection', () => {
    const edges = [{ id: 'e1', source: 'a', target: 'b' }];
    const props = setup('a', edges);

    fireEvent.click(screen.getByRole('button', { name: 'Edit condition of connection to Review' }));
    expect(props.onEditEdge).toHaveBeenCalledWith(edges[0]);
  });

  it('labels decision connections with their branch', () => {
    setup('d', [{ id: 'e1', source: 'd', sourceHandle: 'true', target: 'b' }]);

    expect(screen.getByText('Yes:')).toBeInTheDocument();
  });

  it('renders nothing for an end node, which has no outgoing connections', () => {
    const { container } = render(
      <NodeConnections
        node={NODES.find(n => n.id === 'end')}
        nodes={NODES}
        edges={[]}
        onConnect={jest.fn()}
        onDeleteEdge={jest.fn()}
      />
    );

    expect(container).toBeEmptyDOMElement();
  });
});
