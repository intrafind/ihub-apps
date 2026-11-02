// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The shared Switch: a native button with role="switch" that says whether it
 * is on, has a name from a label, toggles from mouse and keyboard, and does
 * nothing while disabled.
 */
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import Switch from '../../../client/src/shared/components/Switch';

/** A switch that holds its own state, as a screen would. */
function Controlled({ initial = false, onChange = () => {}, ...props }) {
  const [checked, setChecked] = useState(initial);
  return (
    <Switch
      checked={checked}
      onChange={next => {
        setChecked(next);
        onChange(next);
      }}
      {...props}
    />
  );
}

describe('Switch', () => {
  it('is a switch that reports its state through aria-checked', () => {
    const { rerender } = render(<Switch checked={false} onChange={() => {}} aria-label="Wi-Fi" />);
    const toggle = screen.getByRole('switch', { name: 'Wi-Fi' });
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle).toHaveAttribute('type', 'button');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(toggle).not.toBeChecked();

    rerender(<Switch checked onChange={() => {}} aria-label="Wi-Fi" />);
    expect(screen.getByRole('switch', { name: 'Wi-Fi' })).toBeChecked();
  });

  it('calls onChange with the new value on click', () => {
    const onChange = jest.fn();
    render(<Switch checked={false} onChange={onChange} aria-label="Wi-Fi" />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toBe(true);
  });

  it('renders a visible label that names the switch and toggles it on click', () => {
    const onChange = jest.fn();
    render(<Controlled label="Collect feedback" onChange={onChange} />);
    const toggle = screen.getByRole('switch', { name: 'Collect feedback' });
    fireEvent.click(screen.getByText('Collect feedback'));
    expect(onChange).toHaveBeenCalledWith(true);
    expect(toggle).toBeChecked();
  });

  it('wires a description with aria-describedby', () => {
    render(
      <Switch
        checked={false}
        onChange={() => {}}
        label="Store feedback"
        description="Writes submitted feedback to disk."
      />
    );
    expect(screen.getByRole('switch', { name: 'Store feedback' })).toHaveAccessibleDescription(
      'Writes submitted feedback to disk.'
    );
  });

  it('takes its name from a label the screen renders itself', () => {
    render(
      <div>
        <span id="pwa-label">Enable PWA</span>
        <span id="pwa-help">Installs the app.</span>
        <Switch
          checked
          onChange={() => {}}
          aria-labelledby="pwa-label"
          aria-describedby="pwa-help"
        />
      </div>
    );
    const toggle = screen.getByRole('switch', { name: 'Enable PWA' });
    expect(toggle).toHaveAccessibleDescription('Installs the app.');
  });

  it('is in the tab order and toggles with Space and Enter', async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(<Controlled aria-label="Auto-refresh" onChange={onChange} />);

    await user.tab();
    const toggle = screen.getByRole('switch', { name: 'Auto-refresh' });
    expect(toggle).toHaveFocus();

    await user.keyboard(' ');
    expect(toggle).toBeChecked();
    await user.keyboard('{Enter}');
    expect(toggle).not.toBeChecked();
    expect(onChange.mock.calls.map(call => call[0])).toEqual([true, false]);
  });

  it('does nothing while disabled, also through an enclosing disabled fieldset', async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    const { rerender } = render(
      <Switch checked={false} onChange={onChange} aria-label="Pause" disabled />
    );
    const toggle = screen.getByRole('switch', { name: 'Pause' });
    expect(toggle).toBeDisabled();
    await user.click(toggle);
    expect(onChange).not.toHaveBeenCalled();

    rerender(
      <fieldset disabled>
        <Switch checked={false} onChange={onChange} aria-label="Pause" />
      </fieldset>
    );
    expect(screen.getByRole('switch', { name: 'Pause' })).toBeDisabled();
  });

  it('comes in two sizes and has dark-mode colours', () => {
    render(
      <>
        <Switch checked={false} onChange={() => {}} aria-label="Medium" />
        <Switch checked onChange={() => {}} aria-label="Small" size="sm" />
      </>
    );
    const medium = screen.getByRole('switch', { name: 'Medium' });
    const small = screen.getByRole('switch', { name: 'Small' });
    expect(medium).toHaveClass('h-6', 'w-11', 'bg-gray-200', 'dark:bg-gray-600');
    expect(small).toHaveClass('h-5', 'w-9', 'bg-indigo-600');
    expect(small.firstChild).toHaveClass('h-4', 'w-4', 'translate-x-4');
    expect(small.firstChild).toHaveAttribute('aria-hidden', 'true');
  });

  it('gives the small switch a pointer target of at least 24px without changing its track', () => {
    render(
      <>
        <Switch checked={false} onChange={() => {}} aria-label="Medium" />
        <Switch checked onChange={() => {}} aria-label="Small" size="sm" />
      </>
    );
    // The 20px track gets an invisible ::before reaching 4px past its 16px
    // padding box above and below (WCAG 2.5.8); the 24px medium needs none.
    expect(screen.getByRole('switch', { name: 'Small' })).toHaveClass(
      'relative',
      'h-5',
      'before:absolute',
      'before:inset-x-0',
      'before:-inset-y-1'
    );
    expect(screen.getByRole('switch', { name: 'Medium' })).not.toHaveClass('before:absolute');
  });

  it('passes other props to the button but keeps its role and state', () => {
    render(
      <Switch
        checked={false}
        onChange={() => {}}
        aria-label="Flag"
        data-testid="flag-switch"
        role="checkbox"
        aria-checked="mixed"
        id="flag"
      />
    );
    const toggle = screen.getByTestId('flag-switch');
    expect(toggle).toHaveAttribute('role', 'switch');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(toggle).toHaveAttribute('id', 'flag');
  });
});
