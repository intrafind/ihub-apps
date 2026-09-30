import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const interpolate = (text, options) =>
  String(text).replace(/{{(\w+)}}/g, (_, name) => String(options?.[name] ?? ''));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, options) => {
      if (typeof options === 'string') return options;
      if (options && typeof options === 'object') {
        return interpolate(options.defaultValue ?? key, options);
      }
      return key;
    },
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/shared/components/Icon', () => {
  return function Icon({ name }) {
    return <span data-testid={`icon-${name}`} />;
  };
});

jest.mock('../../../client/src/api/client', () => ({
  __esModule: true,
  apiClient: { get: jest.fn(), post: jest.fn() },
  streamingApiClient: { get: jest.fn(), post: jest.fn() }
}));

jest.mock('../../../client/src/shared/contexts/UIConfigContext', () => ({
  __esModule: true,
  useUIConfig: () => ({ uiConfig: { title: { en: 'iHub Apps' } } })
}));

jest.mock('../../../client/src/shared/hooks/useChats', () => ({
  __esModule: true,
  useChatPersistence: () => true
}));

jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  __esModule: true,
  usePlatformConfig: () => ({
    platformConfig: {
      aiTransparency: { enabled: true, labels: { euIcon: 'always', exportLabel: true } }
    },
    isLoading: false
  })
}));

jest.mock('../../../client/src/api/endpoints/exports', () => ({
  __esModule: true,
  requestExport: jest.fn(),
  requestExportText: jest.fn(),
  signClipboardText: jest.fn()
}));

import ExportDialog from '../../../client/src/features/chat/components/ExportDialog';
import { requestExport } from '../../../client/src/api/endpoints/exports';

/**
 * The export dialog sends the user's message selection to the server
 * (`POST /api/exports`, EU AI Act Art. 50(2), issue #2571): all messages by
 * default, never the greeting, and — for a stored chat — by id.
 */

const messages = [
  { id: 'greeting', role: 'assistant', content: 'Welcome!', isGreeting: true },
  { id: 'm1', serverId: 'm1', role: 'user', content: 'First question', fromServer: true },
  { id: 'm2', serverId: 'm2', role: 'assistant', content: 'First answer', fromServer: true },
  { id: 'm3', serverId: 'm3', role: 'user', content: 'Second question', fromServer: true }
];

afterEach(() => jest.clearAllMocks());

describe('ExportDialog message selection', () => {
  it('lists the conversation without the greeting, all selected', () => {
    render(<ExportDialog isOpen onClose={() => {}} messages={messages} appId="chat" chatId="c1" />);
    const boxes = screen.getAllByRole('checkbox', { checked: true });
    // three messages + the locked "EU AI icon" option
    expect(boxes).toHaveLength(4);
    expect(screen.queryByText('Welcome!')).toBeNull();
    expect(screen.getByText('3 of 3 selected')).toBeTruthy();
  });

  it('exports the selected stored messages by id with the locked EU icon', async () => {
    requestExport.mockResolvedValue({ filename: 'x.pdf', manifestId: 'exp_1' });
    render(<ExportDialog isOpen onClose={() => {}} messages={messages} appId="chat" chatId="c1" />);
    fireEvent.click(screen.getByLabelText(/Second question/));
    expect(screen.getByText('2 of 3 selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Export$/ }));

    await waitFor(() => expect(requestExport).toHaveBeenCalledTimes(1));
    expect(requestExport.mock.calls[0][0]).toMatchObject({
      format: 'pdf',
      source: 'chat',
      appId: 'chat',
      chatId: 'c1',
      messageIds: ['m1', 'm2'],
      options: { template: 'default', euIcon: true }
    });
  });

  it('disables export when nothing is selected', () => {
    render(<ExportDialog isOpen onClose={() => {}} messages={messages} appId="chat" chatId="c1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Select none' }));
    expect(screen.getByRole('button', { name: /^Export$/ }).disabled).toBe(true);
  });
});
