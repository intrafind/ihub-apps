import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';

/**
 * Compare mode with a start form (issue #2581): the view shows the panels'
 * headers and one form, and the form's message is broadcast to the panels.
 *
 * The panels must survive the form going away. Each one holds the chat the
 * form's message was just sent into; remounting them when the layout drops the
 * form threw that chat away — and with it the request, which is only made once
 * the panel's stream connects.
 */

jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({ t: (key, def) => (typeof def === 'string' ? def : key) })
}));

const mockPanels = { mounts: 0, props: [] };
jest.mock('../../../client/src/features/chat/components/ComparePanel', () => {
  const React = require('react');
  return {
    __esModule: true,
    default: React.forwardRef(function MockComparePanel(props, _ref) {
      React.useEffect(() => {
        mockPanels.mounts += 1;
      }, []);
      mockPanels.props[props.label === 'Model A' ? 0 : 1] = props;
      return <div data-testid="panel" data-hidden={String(props.hideTranscript)} />;
    })
  };
});

const CompareModeView =
  require('../../../client/src/features/chat/components/CompareModeView').default;

const props = { app: { id: 'acme' }, appId: 'acme', models: [{ id: 'a' }, { id: 'b' }] };

beforeEach(() => {
  mockPanels.mounts = 0;
  mockPanels.props = [];
});

test('shows the panel headers and the one form while it is pending', () => {
  render(<CompareModeView {...props} startForm={<form data-testid="start-form" />} />);

  expect(screen.getAllByTestId('start-form')).toHaveLength(1);
  expect(mockPanels.props.map(p => p.hideTranscript)).toEqual([true, true]);
});

test('keeps the panels when the form goes, so what it sent them stays', () => {
  const { rerender } = render(
    <CompareModeView {...props} startForm={<form data-testid="start-form" />} />
  );
  expect(mockPanels.mounts).toBe(2);

  rerender(<CompareModeView {...props} startForm={null} />);

  expect(screen.queryByTestId('start-form')).toBeNull();
  expect(mockPanels.props.map(p => p.hideTranscript)).toEqual([false, false]);
  expect(mockPanels.mounts).toBe(2);
});
