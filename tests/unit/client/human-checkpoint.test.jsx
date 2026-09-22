/**
 * HumanCheckpoint — the question widgets a workflow / agent `ask_user` needs
 * (multi-select arrays, confirm, "other" entry, skip) next to the approval
 * buttons.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback ?? _key })
}));
jest.mock('../../../client/src/shared/components/Icon', () => () => null);
jest.mock('../../../client/src/shared/components/LoadingSpinner', () => () => null);
jest.mock('../../../client/src/shared/components/ConfirmDialog', () => () => null);
jest.mock('../../../client/src/features/workflows/hooks/useTechnicalDetailsToggle', () => ({
  useTechnicalDetailsToggle: () => [false, () => {}]
}));
jest.mock('../../../client/src/utils/markdownUtils', () => ({
  markdownToHtml: s => s,
  isMarkdown: () => false
}));

import HumanCheckpoint from '../../../client/src/features/workflows/components/HumanCheckpoint';

const submit = () => screen.getByRole('button', { name: /Submit Response/ });

describe('HumanCheckpoint — question widgets', () => {
  test('multi_select submits every selected option as an array', async () => {
    const onRespond = jest.fn().mockResolvedValue();
    render(
      <HumanCheckpoint
        checkpoint={{
          id: 'ckpt-1',
          type: 'input',
          message: 'Which regions?',
          inputType: 'multi_select',
          options: [
            { value: 'eu', label: 'EU' },
            { value: 'us', label: 'US' },
            { value: 'apac', label: 'APAC' }
          ]
        }}
        onRespond={onRespond}
      />
    );
    expect(submit()).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'EU' }));
    await userEvent.click(screen.getByRole('button', { name: 'APAC' }));
    await userEvent.click(submit());
    expect(onRespond).toHaveBeenCalledWith({
      checkpointId: 'ckpt-1',
      response: ['eu', 'apac'],
      data: undefined
    });
  });

  test('confirm without options offers Yes / No', async () => {
    const onRespond = jest.fn().mockResolvedValue();
    render(
      <HumanCheckpoint
        checkpoint={{ id: 'ckpt-2', type: 'question', message: 'Publish?', inputType: 'confirm' }}
        onRespond={onRespond}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: 'Yes' }));
    await userEvent.click(submit());
    expect(onRespond).toHaveBeenCalledWith(
      expect.objectContaining({ checkpointId: 'ckpt-2', response: 'yes' })
    );
  });

  test('single_select with allowOther submits the typed answer, and a question can be skipped', async () => {
    const onRespond = jest.fn().mockResolvedValue();
    render(
      <HumanCheckpoint
        checkpoint={{
          id: 'ckpt-3',
          type: 'question',
          message: 'Which tone?',
          inputType: 'single_select',
          options: [{ value: 'formal', label: 'Formal' }],
          allowOther: true,
          allowSkip: true
        }}
        onRespond={onRespond}
      />
    );
    await userEvent.type(screen.getByPlaceholderText(/Other/), 'playful');
    await userEvent.click(submit());
    expect(onRespond).toHaveBeenCalledWith(
      expect.objectContaining({ checkpointId: 'ckpt-3', response: 'playful' })
    );
    await userEvent.click(screen.getByRole('button', { name: /Skip this question/ }));
    expect(onRespond).toHaveBeenLastCalledWith(
      expect.objectContaining({ checkpointId: 'ckpt-3', response: null, skipped: true })
    );
  });

  test('free text and number questions submit the typed value', async () => {
    const onRespond = jest.fn().mockResolvedValue();
    render(
      <HumanCheckpoint
        checkpoint={{ id: 'ckpt-4', type: 'question', message: 'How many?', inputType: 'number' }}
        onRespond={onRespond}
      />
    );
    await userEvent.type(screen.getByLabelText(/Your answer/), '7');
    await userEvent.click(submit());
    expect(onRespond).toHaveBeenCalledWith(
      expect.objectContaining({ checkpointId: 'ckpt-4', response: '7' })
    );
  });

  test('approval checkpoints keep the option buttons', async () => {
    const onRespond = jest.fn().mockResolvedValue();
    render(
      <HumanCheckpoint
        checkpoint={{
          id: 'ckpt-5',
          type: 'approval',
          message: 'Approve the plan?',
          options: [
            { value: 'approve', label: 'Approve', style: 'primary' },
            { value: 'reject', label: 'Reject', style: 'danger' }
          ]
        }}
        onRespond={onRespond}
      />
    );
    expect(screen.queryByLabelText(/Your answer/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await userEvent.click(submit());
    expect(onRespond).toHaveBeenCalledWith(
      expect.objectContaining({ checkpointId: 'ckpt-5', response: 'approve' })
    );
  });
});
