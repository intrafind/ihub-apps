// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * CapabilityFields: the integrations / systemTools / webSearch editing of
 * workflow nodes and agent profiles (#3275).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockFetchInstalledIntegrations = jest.fn();
jest.mock('../../../client/src/api/integrationsAdminApi', () => ({
  fetchInstalledIntegrations: (...args) => mockFetchInstalledIntegrations(...args)
}));

jest.mock('react-i18next', () => {
  const translate = (key, fallback, options = {}) =>
    Object.entries(options).reduce(
      (out, [name, value]) => out.replaceAll(`{{${name}}}`, String(value)),
      typeof fallback === 'string' ? fallback : key
    );
  const translation = { t: translate, i18n: { language: 'en' } };
  return { useTranslation: () => translation };
});

import CapabilityFields, {
  SYSTEM_TOOL_IDS,
  integrationPickerItems
} from '../../../client/src/shared/components/CapabilityFields';

const installed = [
  { id: 'jira', label: 'Jira', type: 'ticketing', enabled: true },
  { id: 'off', label: 'Off', type: 'ticketing', enabled: false },
  { id: 'broken', label: 'Broken', type: 'x', definitionMissing: true }
];

describe('integrationPickerItems', () => {
  it('offers enabled installations and their types', () => {
    const items = integrationPickerItems(installed, (k, f) => f.replace('{{type}}', 'ticketing'));
    expect(items.map(i => i.id)).toEqual(['jira', 'type:ticketing']);
  });
});

describe('CapabilityFields', () => {
  beforeEach(() => {
    mockFetchInstalledIntegrations.mockReset();
    mockFetchInstalledIntegrations.mockResolvedValue({ items: installed });
  });

  it('writes a picked installation as { [id]: {} } and keeps existing bindings', async () => {
    const onChange = jest.fn();
    render(
      <CapabilityFields
        value={{ integrations: { other: { actions: ['a'] } } }}
        onChange={onChange}
      />
    );
    const input = screen.getByPlaceholderText('Search installed integrations...');
    fireEvent.focus(input);
    fireEvent.click(await screen.findByText('Jira'));
    expect(onChange).toHaveBeenCalledWith({
      integrations: { other: { actions: ['a'] }, jira: {} }
    });
  });

  it('removing the last integration clears the field', () => {
    const onChange = jest.fn();
    render(<CapabilityFields value={{ integrations: { jira: {} } }} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('Remove jira'));
    expect(onChange).toHaveBeenCalledWith({ integrations: undefined });
  });

  it('picks platform tools from the fixed list', async () => {
    const onChange = jest.fn();
    render(<CapabilityFields value={{}} onChange={onChange} />);
    const input = screen.getByPlaceholderText('Search platform tools...');
    fireEvent.focus(input);
    await waitFor(() => expect(screen.getByText(SYSTEM_TOOL_IDS[0])).toBeInTheDocument());
    fireEvent.click(screen.getByText('read_url'));
    expect(onChange).toHaveBeenCalledWith({ systemTools: ['read_url'] });
  });

  it('toggles web search', () => {
    const onChange = jest.fn();
    render(<CapabilityFields value={{}} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('Web search'));
    expect(onChange).toHaveBeenCalledWith({ webSearch: true });
  });
});
