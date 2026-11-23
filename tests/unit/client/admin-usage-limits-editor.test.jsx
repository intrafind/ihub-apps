// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

/**
 * The usage limits of a group: only the limits that are set are shown, each as a
 * card, and "Add a limit" offers the rest. A group without limits shows no input.
 */

jest.mock('react-i18next', () => {
  const translate = (key, defaultValue, options) => {
    let text = typeof defaultValue === 'string' ? defaultValue : key;
    for (const [name, value] of Object.entries(options || {})) {
      text = text.replace(`{{${name}}}`, String(value));
    }
    return text;
  };
  const i18n = { language: 'en' };
  return { useTranslation: () => ({ t: translate, i18n }) };
});

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

jest.mock('../../../client/src/api/adminApi', () => ({
  fetchAdminModels: jest.fn(async () => [
    { id: 'gpt', name: { en: 'GPT' } },
    { id: 'claude', name: { en: 'Claude' }, usageLimits: { day: 500 } },
    { id: 'gemini', name: { en: 'Gemini' } }
  ]),
  makeAdminApiCall: jest.fn(async () => ({ data: { allModels: {} } }))
}));

import UsageLimitsEditor, {
  normalizeUsageLimits
} from '../../../client/src/features/admin/components/UsageLimitsEditor';

/** Holds the limits like the group page does, and exposes what would be saved. */
function Harness({ initial, modelIds = ['*'], onValue }) {
  const [value, setValue] = useState(initial);
  return (
    <UsageLimitsEditor
      level="group"
      value={value}
      modelIds={modelIds}
      onChange={next => {
        setValue(next);
        onValue?.(next);
      }}
    />
  );
}

const picker = () => screen.getByLabelText('Add a limit');
const optionLabels = () =>
  within(picker())
    .getAllByRole('option')
    .map(option => option.textContent);

describe('UsageLimitsEditor (group)', () => {
  test('shows no input at all while nothing is configured', async () => {
    render(<Harness initial={undefined} />);
    await waitFor(() => expect(optionLabels()).toContain('Claude'));

    expect(screen.getByTestId('usage-limits-empty')).toHaveTextContent(
      'No limits are set for this group.'
    );
    expect(screen.queryAllByTestId('usage-limit-card')).toHaveLength(0);
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
  });

  test('lists only the configured limits, models by name', async () => {
    render(
      <Harness
        initial={{
          allModels: { day: 1000 },
          fileStorageBytes: 5 * 1024 * 1024,
          models: { gpt: { week: 200 }, claude: { day: 100 } }
        }}
      />
    );
    await waitFor(() => expect(optionLabels()).toContain('Gemini'));

    const cards = screen.getAllByTestId('usage-limit-card');
    expect(cards.map(card => card.getAttribute('aria-label'))).toEqual([
      'All models',
      'File storage',
      'Claude',
      'GPT'
    ]);
    expect(screen.queryByTestId('usage-limits-empty')).not.toBeInTheDocument();
    // A model that has a limit is not offered again; one without is.
    expect(optionLabels()).not.toContain('GPT');
    expect(optionLabels()).toContain('Gemini');
  });

  test('adds a model limit, focuses its first field and saves what is typed', async () => {
    const onValue = jest.fn();
    render(<Harness initial={undefined} onValue={onValue} />);
    await waitFor(() => expect(optionLabels()).toContain('Gemini'));

    fireEvent.change(picker(), { target: { value: 'model:gemini' } });

    const card = await screen.findByLabelText('Gemini', { selector: 'section' });
    const daily = within(card).getByLabelText('Gemini – Daily');
    await waitFor(() => expect(daily).toHaveFocus());
    // An added limit without a value is not saved.
    expect(onValue).not.toHaveBeenCalled();

    fireEvent.change(daily, { target: { value: '250' } });
    expect(onValue).toHaveBeenLastCalledWith({ models: { gemini: { day: 250 } } });
    expect(optionLabels()).not.toContain('Gemini');
  });

  test('offers the general limits and takes them off the list once added', async () => {
    render(<Harness initial={undefined} />);
    await waitFor(() => expect(optionLabels()).toContain('Gemini'));
    expect(optionLabels()).toEqual(
      expect.arrayContaining(['All models together', 'File storage', 'All other models'])
    );

    fireEvent.change(picker(), { target: { value: 'files' } });

    expect(await screen.findByLabelText('Storage limit (MB)')).toBeInTheDocument();
    expect(optionLabels()).not.toContain('File storage');
  });

  test('keeps a card while its fields are cleared, and removes it on request', async () => {
    const onValue = jest.fn();
    render(<Harness initial={{ models: { gpt: { day: 100 } } }} onValue={onValue} />);
    const daily = await screen.findByLabelText('GPT – Daily');

    fireEvent.change(daily, { target: { value: '' } });
    expect(onValue).toHaveBeenLastCalledWith(undefined);
    expect(screen.getByLabelText('GPT – Daily')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Remove limit: GPT'));
    expect(screen.queryByLabelText('GPT – Daily')).not.toBeInTheDocument();
    expect(screen.getByTestId('usage-limits-empty')).toBeInTheDocument();
  });

  test('removing a configured limit drops it from the saved data', async () => {
    const onValue = jest.fn();
    render(
      <Harness
        initial={{ allModels: { day: 1000 }, models: { gpt: { day: 100 } } }}
        onValue={onValue}
      />
    );
    await screen.findByLabelText('GPT – Daily');

    fireEvent.click(screen.getByLabelText('Remove limit: GPT'));

    expect(onValue).toHaveBeenLastCalledWith({ allModels: { day: 1000 } });
  });

  test('keeps the "All other models" card while its fields are cleared, without a * permission', async () => {
    const onValue = jest.fn();
    render(
      <Harness initial={{ models: { '*': { day: 5 } } }} modelIds={['gpt']} onValue={onValue} />
    );
    const daily = await screen.findByLabelText('All other models – Daily');

    fireEvent.change(daily, { target: { value: '' } });

    expect(onValue).toHaveBeenLastCalledWith(undefined);
    // Clearing the last field removed the stored `*` entry, but the card stays until Remove.
    expect(screen.getByLabelText('All other models – Daily')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Remove limit: All other models'));
    expect(screen.queryByLabelText('All other models – Daily')).not.toBeInTheDocument();
    // Without the * permission it is not offered again.
    await waitFor(() => expect(optionLabels()).toContain('GPT'));
    expect(optionLabels()).not.toContain('All other models');
  });

  test('offers only the models the group can use when none is a wildcard', async () => {
    render(<Harness initial={undefined} modelIds={['gpt']} />);
    await waitFor(() => expect(optionLabels()).toContain('GPT'));

    expect(optionLabels()).not.toContain('Claude');
    expect(optionLabels()).not.toContain('All other models');
  });
});

describe('normalizeUsageLimits', () => {
  test('an emptied card leaves nothing to save', () => {
    expect(normalizeUsageLimits({ models: { gpt: {} } })).toBeNull();
  });
});
