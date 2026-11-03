// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import i18next from 'i18next';
import en from '../../../shared/i18n/en.json';
import de from '../../../shared/i18n/de.json';
import ActionReviewBadge from '../../../client/src/features/admin/components/integrations/ActionReviewBadge';
import {
  actionsPendingReview,
  approvalChanged,
  approvalPayload,
  normalizeApproval,
  withNewOrChangedMode
} from '../../../client/src/features/admin/components/integrations/installationApproval';
import { installApprovalPreset } from '../../../shared/toolApproval.js';

/**
 * The "New" / "Changed" badge of an action whose fingerprint an admin has
 * not accepted (#2916), in both languages, and the approval helpers that
 * carry `newOrChanged`.
 */

const mockI18n = i18next.createInstance();
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockI18n.t.bind(mockI18n), i18n: mockI18n })
}));

beforeAll(async () => {
  await mockI18n.init({
    lng: 'en',
    resources: { en: { translation: en }, de: { translation: de } },
    parseMissingKeyHandler: key => `MISSING:${key}`,
    saveMissing: false
  });
});

afterEach(async () => {
  await mockI18n.changeLanguage('en');
});

describe('ActionReviewBadge', () => {
  test('a new action gets the info badge', () => {
    render(<ActionReviewBadge review="new" />);
    const badge = screen.getByTestId('action-review-badge');
    expect(badge).toHaveTextContent('New');
    expect(badge.className).toMatch(/bg-blue-100/);
    expect(badge).toHaveAttribute('title', expect.stringContaining('mark it reviewed'));
  });

  test('a changed action gets the warning badge', () => {
    render(<ActionReviewBadge review="changed" />);
    const badge = screen.getByTestId('action-review-badge');
    expect(badge).toHaveTextContent('Changed');
    expect(badge.className).toMatch(/bg-amber-100/);
  });

  test('a reviewed action has no badge', () => {
    const { container } = render(<ActionReviewBadge review={null} />);
    expect(container).toBeEmptyDOMElement();
    render(<ActionReviewBadge review="bogus" />);
    expect(screen.queryByTestId('action-review-badge')).not.toBeInTheDocument();
  });

  test('German', async () => {
    await mockI18n.changeLanguage('de');
    render(
      <>
        <ActionReviewBadge review="new" />
        <ActionReviewBadge review="changed" />
      </>
    );
    expect(screen.getByText('Neu')).toBeInTheDocument();
    expect(screen.getByText('Geändert')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/MISSING:/);
  });
});

describe('installation approval helpers with newOrChanged', () => {
  test('normalize, payload and change detection keep newOrChanged', () => {
    const stored = { default: 'writes', newOrChanged: 'writes', bogus: 1 };
    expect(normalizeApproval(stored)).toEqual({
      default: 'writes',
      newOrChanged: 'writes',
      actions: {}
    });
    const draft = withNewOrChangedMode(normalizeApproval(stored), 'never');
    expect(approvalPayload(draft)).toEqual({ default: 'writes', newOrChanged: 'never' });
    expect(approvalChanged(stored, draft)).toBe(true);
    const cleared = withNewOrChangedMode(draft, undefined);
    expect(approvalPayload(cleared)).toEqual({ default: 'writes' });
    expect(approvalPayload(withNewOrChangedMode(normalizeApproval(null), 'always'))).toEqual({
      newOrChanged: 'always'
    });
  });

  test('actionsPendingReview lists new and changed actions in order', () => {
    expect(
      actionsPendingReview([
        { name: 'a', review: null },
        { name: 'b', review: 'changed' },
        { name: 'c' },
        { name: 'd', review: 'new' }
      ])
    ).toEqual(['b', 'd']);
    expect(actionsPendingReview(undefined)).toEqual([]);
  });

  test('install preset (shared with the server)', () => {
    expect(installApprovalPreset({ dynamicActions: true })).toBe('always');
    expect(installApprovalPreset({ actions: [{ sideEffect: 'read', dataFlow: 'external' }] })).toBe(
      'writes'
    );
  });
});
