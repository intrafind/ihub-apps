// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { StrictMode } from 'react';
import { render, renderHook } from '@testing-library/react';

import useSurface from '../../../client/src/shared/hooks/useSurface';

/**
 * `useSurface('admin')` scopes the admin's form-control CSS (`App.css`) to the admin. If the
 * attribute outlived the admin (a missing cleanup, or a StrictMode double effect), end-user pages
 * reached by client-side navigation from /admin would get the admin's field styling.
 */

const surface = () => document.documentElement.getAttribute('data-surface');

afterEach(() => {
  document.documentElement.removeAttribute('data-surface');
});

describe('useSurface', () => {
  test('sets data-surface on <html> while mounted and removes it on unmount', () => {
    const { unmount } = renderHook(() => useSurface('admin'));
    expect(surface()).toBe('admin');
    unmount();
    expect(surface()).toBeNull();
  });

  test('restores the previous value instead of deleting it', () => {
    document.documentElement.setAttribute('data-surface', 'outer');
    const { unmount } = renderHook(() => useSurface('admin'));
    expect(surface()).toBe('admin');
    unmount();
    expect(surface()).toBe('outer');
  });

  test('survives the StrictMode double effect', () => {
    function Admin() {
      useSurface('admin');
      return null;
    }
    const { unmount } = render(
      <StrictMode>
        <Admin />
      </StrictMode>
    );
    expect(surface()).toBe('admin');
    unmount();
    expect(surface()).toBeNull();
  });

  test('nested callers unwind in order', () => {
    const outer = renderHook(() => useSurface('admin'));
    const inner = renderHook(() => useSurface('preview'));
    expect(surface()).toBe('preview');
    inner.unmount();
    expect(surface()).toBe('admin');
    outer.unmount();
    expect(surface()).toBeNull();
  });
});
