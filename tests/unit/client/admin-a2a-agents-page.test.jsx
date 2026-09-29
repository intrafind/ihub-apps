/**
 * Admin → Integrations → A2A agents: the dialog edits an agent's name and
 * description per language with the shared DynamicLanguageEditor. The PUT
 * route replaces the whole agent, so the languages the admin did not touch must
 * go back unchanged, and a language left empty must not be sent (the schema
 * rejects empty texts).
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockMakeAdminApiCall = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: (...args) => mockMakeAdminApiCall(...args),
  translateText: jest.fn()
}));
jest.mock('../../../client/src/features/admin/components/OpenApiToolEditor', () => ({
  CredentialRefSelect: () => null
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
const mockT = (key, defaultOrOptions, maybeOptions) => {
  const options = typeof defaultOrOptions === 'object' ? defaultOrOptions : maybeOptions || {};
  const text = typeof defaultOrOptions === 'string' ? defaultOrOptions : key;
  return Object.entries(options).reduce(
    (out, [name, value]) => out.replace(`{{${name}}}`, value),
    text
  );
};
const mockI18n = { t: mockT, i18n: { language: 'en' } };
jest.mock('react-i18next', () => ({
  useTranslation: () => mockI18n
}));

const AdminA2aAgentsPage =
  require('../../../client/src/features/admin/pages/AdminA2aAgentsPage').default;

const AGENT = {
  id: 'langdock',
  name: { en: 'Langdock', de: 'Langdock-Agent' },
  description: 'A plain description',
  enabled: true,
  cardUrl: 'https://agents.example.com/.well-known/agent-card.json',
  auth: { type: 'none' },
  allowedSkills: ['*'],
  timeoutMs: 60000,
  streaming: 'auto',
  pollIntervalMs: 1500,
  status: { state: 'ok' }
};

function openDialog(agent = AGENT) {
  mockMakeAdminApiCall.mockReset();
  mockMakeAdminApiCall.mockImplementation(async url => {
    if (url === '/admin/a2a/agents') return { data: { agents: [agent] } };
    return { data: {} };
  });
  render(<AdminA2aAgentsPage />);
  return screen.findByRole('button', { name: 'Edit' }).then(button => fireEvent.click(button));
}

async function savedBody() {
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(mockMakeAdminApiCall).toHaveBeenCalledWith(
      '/admin/a2a/agents/langdock',
      expect.objectContaining({ method: 'PUT' })
    )
  );
  return mockMakeAdminApiCall.mock.calls.find(([, options]) => options?.method === 'PUT')[1].body;
}

describe('AdminA2aAgentsPage name and description', () => {
  test('shows every stored language and saves the untouched ones unchanged', async () => {
    await openDialog();
    expect(screen.getByDisplayValue('Langdock')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Langdock-Agent')).toBeInTheDocument();
    // A plain-string description from a hand-edited config shows up as English.
    expect(screen.getByDisplayValue('A plain description')).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue('Langdock'), { target: { value: 'Langdock agent' } });
    const body = await savedBody();

    expect(body.name).toEqual({ en: 'Langdock agent', de: 'Langdock-Agent' });
    expect(body.description).toEqual({ en: 'A plain description' });
  });

  test('leaves an emptied language and an empty description out of the request', async () => {
    await openDialog({ ...AGENT, description: undefined });
    fireEvent.change(screen.getByDisplayValue('Langdock-Agent'), { target: { value: '' } });
    const body = await savedBody();

    expect(body.name).toEqual({ en: 'Langdock' });
    expect(body.description).toBeUndefined();
  });
});
