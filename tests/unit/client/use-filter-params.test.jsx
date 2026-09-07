import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import '@testing-library/jest-dom';

import {
  useFilterState,
  useFilterParams
} from '../../../client/src/features/admin/hooks/useFilterState';

/**
 * The root cause behind issue #2213: React Router's `setSearchParams` does not
 * queue the way React's `setState` does. Its functional updater is handed the
 * *render-time* params, so two calls in the same tick both compute from the
 * pre-change URL and the second navigation discards the first.
 *
 * These tests pin both halves of that: the trap `useFilterState` carries (so
 * nobody "simplifies" `useFilterParams` away), and the batching guarantee
 * `useFilterParams` exists to provide.
 */

function Search() {
  const location = useLocation();
  return <div data-testid="search">{location.search}</div>;
}

const search = () => screen.getByTestId('search').textContent;

function renderAt(ui, initial = '/x') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      {ui}
      <Search />
    </MemoryRouter>
  );
}

describe('useFilterState', () => {
  function OneSetter() {
    const [resource, setResource] = useFilterState('resource', 'all');
    return (
      <button type="button" onClick={() => setResource('app')}>
        {resource}
      </button>
    );
  }

  it('writes a single parameter', () => {
    renderAt(<OneSetter />);
    fireEvent.click(screen.getByRole('button'));
    expect(search()).toBe('?resource=app');
  });

  it('removes the parameter when set back to its default', () => {
    function Toggle() {
      const [resource, setResource] = useFilterState('resource', 'all');
      return (
        <button type="button" onClick={() => setResource(resource === 'all' ? 'app' : 'all')}>
          go
        </button>
      );
    }
    renderAt(<Toggle />);
    fireEvent.click(screen.getByRole('button'));
    expect(search()).toBe('?resource=app');
    fireEvent.click(screen.getByRole('button'));
    expect(search()).toBe('');
  });

  it('loses the first update when two setters run in the same tick', () => {
    // This is the bug, kept as an executable warning: `page` is written and
    // `resource` is lost, which is exactly what made every audit log filter
    // appear to do nothing.
    function TwoSetters() {
      const [, setResource] = useFilterState('resource', 'all');
      const [, setPage] = useFilterState('page', '1');
      return (
        <button
          type="button"
          onClick={() => {
            setResource('app');
            setPage('2');
          }}
        >
          go
        </button>
      );
    }
    renderAt(<TwoSetters />);
    fireEvent.click(screen.getByRole('button'));

    expect(search()).toBe('?page=2');
    expect(search()).not.toContain('resource');
  });
});

describe('useFilterParams', () => {
  function Batched({ updates }) {
    const { get, setMany } = useFilterParams({ page: '1', pageSize: '50' });
    return (
      <>
        <button type="button" onClick={() => setMany(updates)}>
          go
        </button>
        <span data-testid="page">{get('page')}</span>
      </>
    );
  }

  it('applies several parameters in one navigation', () => {
    renderAt(<Batched updates={{ resource: 'app', page: '2' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'go' }));

    const params = new URLSearchParams(search());
    expect(params.get('resource')).toBe('app');
    expect(params.get('page')).toBe('2');
  });

  it('changes a filter and resets the page in the same navigation', () => {
    renderAt(<Batched updates={{ resource: 'app', page: null }} />, '/x?page=4');
    fireEvent.click(screen.getByRole('button', { name: 'go' }));

    expect(search()).toBe('?resource=app');
    expect(screen.getByTestId('page')).toHaveTextContent('1');
  });

  it('drops a parameter set to its default, null, or an empty string', () => {
    renderAt(
      <Batched updates={{ page: '1', pageSize: null, q: '' }} />,
      '/x?page=3&pageSize=100&q=hi'
    );
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    expect(search()).toBe('');
  });

  it('writes repeated parameters for an array, so values may contain commas', () => {
    renderAt(<Batched updates={{ actor: ['Doe, John', 'alice'] }} />);
    fireEvent.click(screen.getByRole('button', { name: 'go' }));

    expect(new URLSearchParams(search()).getAll('actor')).toEqual(['Doe, John', 'alice']);
  });

  it('replaces rather than appends to an existing repeated parameter', () => {
    renderAt(<Batched updates={{ actor: ['bob'] }} />, '/x?actor=alice&actor=carol');
    fireEvent.click(screen.getByRole('button', { name: 'go' }));

    expect(new URLSearchParams(search()).getAll('actor')).toEqual(['bob']);
  });

  it('removes a parameter set to an empty array', () => {
    renderAt(<Batched updates={{ actor: [] }} />, '/x?actor=alice');
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    expect(search()).toBe('');
  });

  it('leaves parameters it was not given alone', () => {
    renderAt(<Batched updates={{ resource: 'app' }} />, '/x?from=2026-08-01');
    fireEvent.click(screen.getByRole('button', { name: 'go' }));

    const params = new URLSearchParams(search());
    expect(params.get('from')).toBe('2026-08-01');
    expect(params.get('resource')).toBe('app');
  });

  it('falls back to the declared default when a parameter is absent', () => {
    renderAt(<Batched updates={{}} />);
    expect(screen.getByTestId('page')).toHaveTextContent('1');
  });
});
