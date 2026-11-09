// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

/**
 * Tool search in the app editor (#2889): while the platform's `toolSearch`
 * feature is on, the Tools section lets an app switch it off or set its token
 * budget, and every bound integration has an "Always loaded" checkbox that
 * keeps its tools out of the search. With the feature off neither is shown.
 */

jest.mock('react-i18next', () => {
  const translate = (key, defaultValue) => (typeof defaultValue === 'string' ? defaultValue : key);
  const i18n = { language: 'en' };
  return { useTranslation: () => ({ t: translate, i18n }) };
});

import IntegrationBindingOptions from '../../../client/src/features/admin/components/app-form/IntegrationBindingOptions';
import ToolsConfigSection from '../../../client/src/features/admin/components/app-form/ToolsConfigSection';

describe('the Always loaded checkbox of a binding', () => {
  it('is not shown while tool search is off', () => {
    render(<IntegrationBindingOptions idPrefix="b" binding={{}} onBindingChange={jest.fn()} />);
    expect(screen.queryByLabelText(/Always loaded/)).not.toBeInTheDocument();
  });

  it('sets alwaysLoaded on the binding and removes it again, keeping the other settings', () => {
    const onBindingChange = jest.fn();
    const { rerender } = render(
      <IntegrationBindingOptions
        idPrefix="b"
        binding={{ actions: ['search'] }}
        onBindingChange={onBindingChange}
        toolSearchEnabled
      />
    );
    const checkbox = screen.getByLabelText(/Always loaded/);
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    expect(onBindingChange).toHaveBeenLastCalledWith({ actions: ['search'], alwaysLoaded: true });

    rerender(
      <IntegrationBindingOptions
        idPrefix="b"
        binding={{ actions: ['search'], alwaysLoaded: true }}
        onBindingChange={onBindingChange}
        toolSearchEnabled
      />
    );
    expect(screen.getByLabelText(/Always loaded/)).toBeChecked();
    fireEvent.click(screen.getByLabelText(/Always loaded/));
    expect(onBindingChange).toHaveBeenLastCalledWith({ actions: ['search'] });
  });
});

describe('the tool search settings of an app', () => {
  const renderSection = props =>
    render(<ToolsConfigSection toolChoice={undefined} onToolChoiceChange={jest.fn()} {...props} />);

  it('are not shown while tool search is off', () => {
    renderSection({});
    expect(screen.queryByLabelText('Tool search')).not.toBeInTheDocument();
  });

  it('start on automatic with the default budget', () => {
    renderSection({ toolSearch: undefined, onToolSearchChange: jest.fn() });
    expect(screen.getByLabelText('Tool search')).toHaveValue('auto');
    expect(screen.getByLabelText('Token budget for tool definitions')).toHaveValue(null);
  });

  it('switch tool search off, and hide the budget then', () => {
    const onToolSearchChange = jest.fn();
    const { rerender } = render(
      <ToolsConfigSection
        onToolChoiceChange={jest.fn()}
        toolSearch={undefined}
        onToolSearchChange={onToolSearchChange}
      />
    );
    fireEvent.change(screen.getByLabelText('Tool search'), { target: { value: 'off' } });
    expect(onToolSearchChange).toHaveBeenLastCalledWith({ mode: 'off' });

    rerender(
      <ToolsConfigSection
        onToolChoiceChange={jest.fn()}
        toolSearch={{ mode: 'off' }}
        onToolSearchChange={onToolSearchChange}
      />
    );
    expect(screen.queryByLabelText('Token budget for tool definitions')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Tool search'), { target: { value: 'auto' } });
    expect(onToolSearchChange).toHaveBeenLastCalledWith(undefined);
  });

  it('set the budget as a number, and clear it with an empty field', () => {
    const onToolSearchChange = jest.fn();
    render(
      <ToolsConfigSection
        onToolChoiceChange={jest.fn()}
        toolSearch={{ maxToolTokens: 4000 }}
        onToolSearchChange={onToolSearchChange}
      />
    );
    const budget = screen.getByLabelText('Token budget for tool definitions');
    expect(budget).toHaveValue(4000);
    fireEvent.change(budget, { target: { value: '8000' } });
    expect(onToolSearchChange).toHaveBeenLastCalledWith({ maxToolTokens: 8000 });
    fireEvent.change(budget, { target: { value: '' } });
    expect(onToolSearchChange).toHaveBeenLastCalledWith(undefined);
  });
});
