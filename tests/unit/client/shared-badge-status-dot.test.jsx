// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The shared Badge and StatusDot: a badge is text with a colour pair for light
 * and dark mode; a status dot never shows its status by colour alone.
 */
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import Badge, { BADGE_TONES } from '../../../client/src/shared/components/Badge';
import StatusDot, { STATUS_DOT_STATUSES } from '../../../client/src/shared/components/StatusDot';

jest.mock('react-i18next', () => {
  const en = require('../../../shared/i18n/en.json');
  const lookup = key => key.split('.').reduce((node, part) => node?.[part], en);
  return {
    useTranslation: () => ({
      t: key => (typeof lookup(key) === 'string' ? lookup(key) : `MISSING:${key}`),
      i18n: { language: 'en' }
    })
  };
});

const en = require('../../../shared/i18n/en.json');
const de = require('../../../shared/i18n/de.json');

describe('Badge', () => {
  it('renders its text with the soft colours of its tone in both themes', () => {
    render(<Badge tone="info">Preview</Badge>);
    expect(screen.getByText('Preview')).toHaveClass(
      'bg-blue-100',
      'text-blue-800',
      'dark:bg-blue-900/50',
      'dark:text-blue-300',
      'text-xs',
      'rounded-full'
    );
  });

  it('has a tone for every state the admin shows', () => {
    expect(BADGE_TONES).toEqual([
      'neutral',
      'info',
      'success',
      'warning',
      'danger',
      'accent',
      'highlight'
    ]);
  });

  it('draws only a border in the outline variant', () => {
    render(
      <Badge tone="danger" variant="outline">
        Destructive
      </Badge>
    );
    const badge = screen.getByText('Destructive');
    expect(badge).toHaveClass('border', 'border-red-300', 'text-red-800', 'dark:text-red-300');
    expect(badge).not.toHaveClass('bg-red-100');
  });

  it('falls back to neutral for an unknown tone and to soft for an unknown variant', () => {
    render(
      <Badge tone="sparkly" variant="glow">
        Community
      </Badge>
    );
    expect(screen.getByText('Community')).toHaveClass('bg-gray-100', 'dark:bg-gray-700');
  });

  it('has a square shape, a larger size and a decorative icon', () => {
    render(
      <Badge tone="success" shape="rounded" size="md" icon={<svg data-testid="icon" />}>
        Installed
      </Badge>
    );
    const badge = screen.getByText('Installed');
    expect(badge).toHaveClass('rounded-sm', 'text-sm');
    expect(screen.getByTestId('icon').parentElement).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('StatusDot', () => {
  it.each(STATUS_DOT_STATUSES)(
    '%s has a label in English and German and says it in text',
    status => {
      expect(typeof en.components.statusDot[status]).toBe('string');
      expect(typeof de.components.statusDot[status]).toBe('string');
      expect(de.components.statusDot[status]).not.toBe('');

      const { container } = render(<StatusDot status={status} />);
      const text = screen.getByText(en.components.statusDot[status]);
      expect(text).toHaveClass('sr-only');
      const dot = container.querySelector('[aria-hidden="true"]');
      expect(dot).toHaveAttribute('title', en.components.statusDot[status]);
      expect(container.firstChild).toHaveAttribute('data-status', status);
    }
  );

  it('gives each status its own look, and off a hollow ring', () => {
    const classesOf = status => {
      const { container, unmount } = render(<StatusDot status={status} />);
      const classes = container.querySelector('[aria-hidden="true"]').className;
      unmount();
      return classes;
    };
    const looks = STATUS_DOT_STATUSES.map(classesOf);
    expect(new Set(looks).size).toBe(STATUS_DOT_STATUSES.length);
    expect(classesOf('off')).toContain('border-2');
    expect(classesOf('error')).toContain('dark:bg-red-400');
  });

  it('shows a specific label next to the dot when asked', () => {
    render(<StatusDot status="ok" label="Connected as you" showLabel />);
    const text = screen.getByText('Connected as you');
    expect(text).not.toHaveClass('sr-only');
    expect(text).toBeVisible();
  });

  it('names an unknown status by its value instead of passing for one it is not', () => {
    const { container } = render(<StatusDot status="rebooting" />);
    expect(screen.getByText('rebooting')).toBeInTheDocument();
    expect(container.firstChild).toHaveAttribute('data-status', 'unknown');
  });
});
