/**
 * The lockout settings in the admin's local authentication form: numbers are
 * stored as numbers, and an emptied field drops the setting (so the server
 * default applies) instead of saving NaN, which the platform schema rejects.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import LocalAuthSection from '../../../client/src/features/admin/components/platform-form/LocalAuthSection';

function renderSection(lockout) {
  const onChange = jest.fn();
  render(
    <LocalAuthSection config={{ localAuth: { enabled: true, lockout } }} onChange={onChange} />
  );
  return onChange;
}

const lastLockout = onChange => onChange.mock.calls.at(-1)[0].localAuth.lockout;

test('stores the failed sign-in limit and the duration as numbers', () => {
  const onChange = renderSection({ enabled: true, maxAttempts: 5, durationMinutes: 15 });

  fireEvent.change(screen.getByLabelText('Failed Sign-ins Before Lockout'), {
    target: { value: '8' }
  });
  expect(lastLockout(onChange)).toEqual({ enabled: true, maxAttempts: 8, durationMinutes: 15 });

  fireEvent.change(screen.getByLabelText('Lockout Duration (minutes)'), {
    target: { value: '30' }
  });
  expect(lastLockout(onChange)).toMatchObject({ durationMinutes: 30 });
});

test('an emptied field drops the setting instead of saving NaN', () => {
  const onChange = renderSection({ enabled: true, maxAttempts: 5, durationMinutes: 15 });

  fireEvent.change(screen.getByLabelText('Failed Sign-ins Before Lockout'), {
    target: { value: '' }
  });
  expect(lastLockout(onChange).maxAttempts).toBeUndefined();

  fireEvent.change(screen.getByLabelText('Lockout Duration (minutes)'), {
    target: { value: '' }
  });
  expect(lastLockout(onChange).durationMinutes).toBeUndefined();
  expect(JSON.stringify(lastLockout(onChange))).not.toContain('null');
});

test('shows the demo accounts option as on when it is not set, like the server', () => {
  renderSection(undefined);
  expect(screen.getByRole('checkbox', { name: /Show Demo Accounts in Login Form/ })).toBeChecked();
});
