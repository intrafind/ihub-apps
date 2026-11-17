// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The browser Back/Forward gate of useUnsavedChanges is installed by the client
 * entry (client/src/index.jsx) before the app renders, so it is registered
 * before the router's popstate listener. When it was only added on the first
 * guard's mount, the router's listener was observed to run first in Chromium
 * and Forward was not blocked.
 *
 * jsdom runs capture listeners at the target before bubbling ones, so the
 * router's own (bubbling) listener would never show the problem here. A
 * capture listener registered before any guard mounts stands in for "a router
 * listener that runs before a late gate": it must never see a blocked POP.
 * Without the early install below, the gate would be registered after it and
 * this test fails.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { useState } from 'react';
import { BrowserRouter, Link, Route, Routes, useLocation } from 'react-router-dom';
import {
  installUnsavedChangesPopGate,
  useUnsavedChanges
} from '../../../client/src/features/admin/hooks/useUnsavedChanges';

// As client/src/index.jsx does: before anything renders.
installUnsavedChangesPopGate();

// Registered before the guard mounts, in capture mode: runs before a gate
// that would only be added when the guard mounts.
const routerSeen = [];
window.addEventListener('popstate', () => routerSeen.push(window.location.pathname), true);

function Editor() {
  const [value, setValue] = useState('saved');
  const { blocker } = useUnsavedChanges('saved', value);
  return (
    <div>
      <input aria-label="field" value={value} onChange={e => setValue(e.target.value)} />
      <span data-testid="blocker">{blocker.state}</span>
      {blocker.state === 'blocked' && (
        <button type="button" onClick={blocker.proceed}>
          Discard changes
        </button>
      )}
    </div>
  );
}

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname}</span>;
}

describe('unsaved-changes POP gate installed before the app renders', () => {
  beforeEach(() => {
    routerSeen.length = 0;
    window.history.replaceState({ usr: null, key: 'start', idx: 0 }, '', '/start');
  });

  it('a blocked Back never reaches a popstate listener registered before the guard', async () => {
    render(
      <BrowserRouter>
        <Routes>
          <Route path="/start" element={<Link to="/edit">open editor</Link>} />
          <Route path="/edit" element={<Editor />} />
        </Routes>
        <LocationProbe />
      </BrowserRouter>
    );
    fireEvent.click(screen.getByText('open editor'));
    fireEvent.change(screen.getByLabelText('field'), { target: { value: 'edited' } });

    act(() => window.history.back());
    await waitFor(() => expect(screen.getByTestId('blocker')).toHaveTextContent('blocked'));
    // Wait for the restoring popstate too: it is swallowed as well.
    await waitFor(() => expect(window.location.pathname).toBe('/edit'));
    await act(async () => new Promise(resolve => setTimeout(resolve, 20)));
    expect(routerSeen).toEqual([]);
    expect(screen.getByTestId('location')).toHaveTextContent('/edit');

    // Discard: this POP is meant to pass, and does.
    fireEvent.click(screen.getByText('Discard changes'));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/start'));
    expect(routerSeen).toEqual(['/start']);
  });
});
