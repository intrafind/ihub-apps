// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import {
  DISCLAIMER_STORAGE_KEY,
  acknowledgeDisclaimer,
  isDisclaimerAcknowledged,
  nextDisclaimerVersion
} from '../../../client/src/utils/disclaimerAcknowledgement';

/** The popup is asked again when the admin raises the version. */
describe('disclaimer acknowledgement', () => {
  beforeEach(() => window.localStorage.clear());

  it('asks a new visitor', () => {
    expect(isDisclaimerAcknowledged({ version: '1.0' })).toBe(false);
  });

  it('accepts the version that was confirmed and asks again for the next one', () => {
    acknowledgeDisclaimer({ version: '1.0' });
    expect(isDisclaimerAcknowledged({ version: '1.0' })).toBe(true);
    expect(isDisclaimerAcknowledged({ version: '1.1' })).toBe(false);
  });

  it('counts a browser that confirmed before versions were stored as having seen the current one', () => {
    window.localStorage.setItem(DISCLAIMER_STORAGE_KEY, 'true');
    expect(isDisclaimerAcknowledged({ version: '1.0' })).toBe(true);
    expect(isDisclaimerAcknowledged({ version: '1.1' })).toBe(false);
  });

  it('works for a disclaimer without a version', () => {
    acknowledgeDisclaimer({});
    expect(isDisclaimerAcknowledged({})).toBe(true);
  });
});

describe('nextDisclaimerVersion', () => {
  it.each([
    ['3', '4'],
    ['1.0', '1.1'],
    ['v9', 'v10'],
    ['', '2'],
    [undefined, '2'],
    ['draft', '2']
  ])('%j → %s', (version, expected) => {
    expect(nextDisclaimerVersion(version)).toBe(expected);
  });
});
