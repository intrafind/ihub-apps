// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import {
  applyPickerMode,
  derivePinnedScope,
  legacyScopeSettings,
  pickerModeOf,
  resetLegacyScopeSettings,
  setAllowAllSearchProfiles,
  syncPinnedScope
} from '../../../client/src/features/admin/components/app-form/iAssistantBinding';
import {
  applyIFinderPickerMode,
  setStartProfile
} from '../../../client/src/features/admin/components/app-form/iFinderBinding';

describe('iAssistantBinding', () => {
  it('derives the pinned scope: iAssistant, else all profiles, else configured', () => {
    expect(derivePinnedScope({ assistantId: ' x ', allSearchProfiles: true })).toBe('assistant:x');
    expect(derivePinnedScope({ allSearchProfiles: true })).toBe('all');
    expect(derivePinnedScope({ assistantId: '' })).toBe('configured');
    expect(derivePinnedScope(undefined)).toBe('configured');
  });

  it('reads the mode from the picker', () => {
    expect(pickerModeOf(undefined)).toBe('menu');
    expect(pickerModeOf({ scopePicker: 'inline' })).toBe('inline');
    expect(pickerModeOf({ scopePicker: 'hidden' })).toBe('fixed');
  });

  it('applies a mode without a default scope or a stale pin', () => {
    const iassistant = { assistantId: 'x' };
    const fixed = applyPickerMode({ required: false, defaultScope: 'all' }, 'fixed', iassistant);
    expect(fixed).toEqual({ required: false, scopePicker: 'hidden', pinnedScope: 'assistant:x' });
    expect(applyPickerMode(fixed, 'menu', iassistant)).toEqual({ required: false });
    expect(applyPickerMode(fixed, 'inline', iassistant)).toEqual({
      required: false,
      scopePicker: 'inline'
    });
  });

  it('re-derives a fixed pin only, returning the same object when nothing changes', () => {
    const fixed = { scopePicker: 'hidden', pinnedScope: 'configured' };
    expect(syncPinnedScope(fixed, { allSearchProfiles: true }).pinnedScope).toBe('all');
    expect(syncPinnedScope(fixed, {})).toBe(fixed);
    const menu = {};
    expect(syncPinnedScope(menu, { assistantId: 'x' })).toBe(menu);
    expect(syncPinnedScope(undefined, {})).toBeUndefined();
  });

  it('finds legacy scope values and resets them', () => {
    expect(legacyScopeSettings({ defaultScope: 'all' }, {})).toEqual([
      { key: 'defaultScope', value: 'all' }
    ]);
    expect(legacyScopeSettings({ scopePicker: 'hidden', pinnedScope: 'configured' }, {})).toEqual(
      []
    );
    const hand = { scopePicker: 'hidden', pinnedScope: 'assistant:old', defaultScope: 'all' };
    expect(legacyScopeSettings(hand, { assistantId: 'x' })).toHaveLength(2);
    expect(resetLegacyScopeSettings(hand, { assistantId: 'x' })).toEqual({
      scopePicker: 'hidden',
      pinnedScope: 'assistant:x'
    });
    expect(resetLegacyScopeSettings({ pinnedScope: 'all', required: false }, {})).toEqual({
      required: false
    });
  });

  it('sets and clears allowAllSearchProfiles', () => {
    expect(setAllowAllSearchProfiles({}, true)).toEqual({ allowAllSearchProfiles: true });
    expect(setAllowAllSearchProfiles({ allowAllSearchProfiles: true }, false)).toEqual({});
  });
});

describe('iFinderBinding', () => {
  it('pins the start profile, else the installation default, when fixed', () => {
    expect(applyIFinderPickerMode({ defaultScope: 'c' }, 'fixed', 'std')).toEqual({
      defaultScope: 'c',
      scopePicker: 'hidden',
      pinnedScope: 'c'
    });
    expect(applyIFinderPickerMode({}, 'fixed', 'std')).toEqual({
      scopePicker: 'hidden',
      pinnedScope: 'std'
    });
    expect(applyIFinderPickerMode({}, 'fixed')).toEqual({ scopePicker: 'hidden' });
    expect(applyIFinderPickerMode({ scopePicker: 'hidden', pinnedScope: 'c' }, 'menu')).toEqual({});
  });

  it('follows the start profile while fixed and clears it for the default', () => {
    const fixed = { scopePicker: 'hidden', pinnedScope: 'std' };
    expect(setStartProfile(fixed, 'c', 'std')).toEqual({
      scopePicker: 'hidden',
      pinnedScope: 'c',
      defaultScope: 'c'
    });
    expect(setStartProfile({ defaultScope: 'c' }, '', 'std')).toEqual({});
  });
});
