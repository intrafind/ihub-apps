// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import StyleEditor from '../../../client/src/features/admin/components/StyleEditor';

/**
 * Every colour field of the Styles tab has an accessible name: the picker and the
 * hex input of each color, and the preset swatches. Without it, a screen reader
 * announces an unnamed color well (axe `label`, critical).
 */

jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildPath: path => path,
  buildAssetUrl: path => path,
  buildUploadUrl: path => path,
  buildApiUrl: path => path
}));

const t = (key, fallback, options) => {
  if (typeof fallback !== 'string') return key;
  return fallback.replace('{{name}}', options?.name ?? '');
};

describe('StyleEditor colour fields', () => {
  beforeEach(() => {
    render(<StyleEditor config={{ theme: {} }} onUpdate={() => {}} t={t} />);
  });

  it('names every color picker after its color', () => {
    const pickers = document.querySelectorAll('input[type="color"]');
    expect(pickers.length).toBeGreaterThan(8);
    pickers.forEach(picker => {
      expect(picker.getAttribute('aria-label')).toMatch(/\(color picker\)$/);
    });
  });

  it('ties every hex input to the visible label of its color', () => {
    const inputs = document.querySelectorAll('input[type="text"][id^="theme-color-"]');
    expect(inputs.length).toBe(document.querySelectorAll('input[type="color"]').length);
    inputs.forEach(input => {
      expect(input.labels.length).toBe(1);
      expect(input.labels[0].textContent.trim()).not.toBe('');
    });
  });

  it('gives each preset swatch a name and keeps it from submitting a form', () => {
    const swatches = screen.getAllByRole('button', { name: /^#[0-9a-f]{6}$/i });
    expect(swatches.length).toBeGreaterThan(8);
    swatches.forEach(swatch => expect(swatch).toHaveAttribute('type', 'button'));
  });
});
