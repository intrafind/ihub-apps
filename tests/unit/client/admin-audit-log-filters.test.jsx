import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import '@testing-library/jest-dom';

/**
 * AdminAuditLogPage filter tests — issue #2213.
 *
 * The headline case is the reported bug: selecting a filter did nothing at all,
 * because the page called two `useFilterState` setters in the same tick and
 * React Router's `setSearchParams` does not queue, so the second navigation
 * discarded the first. "lands in the URL and in the refetch query string"
 * below is the regression guard for that.
 */

// `t` must keep a stable identity across renders, as the real i18next hook
// does — the page memoizes its fetch on it.
jest.mock('react-i18next', () => {
  const translate = (key, defaultValue, opts) => {
    let str = typeof defaultValue === 'string' ? defaultValue : key;
    if (opts && typeof str === 'string') {
      for (const [k, v] of Object.entries(opts)) {
        str = str.replace(new RegExp(`{{${k}}}`, 'g'), v);
      }
    }
    return str;
  };
  const i18n = { language: 'en' };
  return { useTranslation: () => ({ t: translate, i18n }) };
});

jest.mock('../../../client/src/shared/components/Icon', () => {
  return function Icon({ name }) {
    return <span data-testid={`icon-${name}`}>{name}</span>;
  };
});

const mockMakeAdminApiCall = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: (...args) => mockMakeAdminApiCall(...args)
}));

import AdminAuditLogPage from '../../../client/src/features/admin/pages/AdminAuditLogPage';

const FACETS = {
  actor: [
    { value: 'alice', count: 12 },
    { value: 'bob', count: 3 }
  ],
  resource: [
    { value: 'auth', count: 10 },
    { value: 'app', count: 5 }
  ],
  action: [
    { value: 'login', count: 794 },
    { value: 'create', count: 8 },
    { value: 'update', count: 2 }
  ],
  result: [
    { value: 'success', count: 800 },
    { value: 'failure', count: 4 }
  ],
  source: [
    { value: 'web', count: 700 },
    { value: 'admin', count: 104 }
  ]
};

const ENTRY = {
  id: 'entry-1',
  ts: '2026-08-24T10:00:00.000Z',
  actor: { username: 'alice', authenticated: true },
  action: 'create',
  resource: 'app',
  result: 'success',
  source: 'admin',
  summary: 'Created the chat app'
};

/** Renders the location's query string so assertions can read the URL state. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-search">{location.search}</div>;
}

function setup() {
  mockMakeAdminApiCall.mockImplementation(url => {
    if (url.startsWith('/admin/audit-log/retention')) {
      return Promise.resolve({ data: { retentionDays: 365, cleanupEnabled: true } });
    }
    return Promise.resolve({ data: { entries: [ENTRY], total: 1, facets: FACETS } });
  });

  const utils = render(
    <MemoryRouter initialEntries={['/admin/audit-log']}>
      <AdminAuditLogPage />
      <LocationProbe />
    </MemoryRouter>
  );
  return utils;
}

/** Every audit-log list request made so far, oldest first. */
function listCalls() {
  return mockMakeAdminApiCall.mock.calls
    .map(([url]) => url)
    .filter(url => url.startsWith('/admin/audit-log?'));
}

const lastListCall = () => listCalls()[listCalls().length - 1];
const urlSearch = () => screen.getByTestId('location-search').textContent;

/** The trigger button of one filter, addressed by its field name. */
const triggerFor = label => screen.getByRole('button', { name: new RegExp(`^${label}\\b`) });

/**
 * Wait until the facets response has been applied. Source is never filtered in
 * these tests, so its trigger goes from "No values in range" to "All sources"
 * exactly when the facets land.
 */
const waitForFacets = () =>
  waitFor(() => expect(triggerFor('Source')).toHaveTextContent('All sources'));

/** Open a filter popover by its field name and return its trigger. */
function openFilter(label) {
  const trigger = triggerFor(label);
  fireEvent.click(trigger);
  return trigger;
}

/** The open popover. Scoping to it keeps table cells out of option queries. */
const popover = () => within(screen.getByRole('group'));

function checkboxFor(labelText) {
  const row = popover().getByText(labelText).closest('label');
  return within(row).getByRole('checkbox');
}

beforeEach(() => {
  mockMakeAdminApiCall.mockReset();
});

describe('AdminAuditLogPage filters reach the URL and the server', () => {
  it('renders checkbox options with their entry counts from the facets payload', async () => {
    setup();
    await waitForFacets();

    // The first request asks for facets, in the same scan as the query.
    expect(lastListCall()).toContain('facets=1');

    openFilter('Action');

    expect(popover().getByText('login')).toBeInTheDocument();
    expect(popover().getByText('794')).toBeInTheDocument();
    expect(popover().getByText('create')).toBeInTheDocument();
  });

  it('lands a deselected value in the URL and in the refetch query string', async () => {
    setup();
    await waitForFacets();
    const before = listCalls().length;

    openFilter('Action');
    fireEvent.click(checkboxFor('login'));

    // The reported bug: the filter never reached the URL at all.
    await waitFor(() => expect(urlSearch()).toContain('actionExclude=login'));
    // ...and it must reach the server too, not just the address bar.
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(before));
    expect(decodeURIComponent(lastListCall())).toContain('actionExclude=login');
  });

  it('resets to page 1 in the same navigation that changes a filter', async () => {
    setup();
    await waitForFacets();

    // Move off page 1 first.
    openFilter('Resource');
    fireEvent.click(checkboxFor('auth'));
    await waitFor(() => expect(urlSearch()).toContain('resourceExclude=auth'));

    // page is omitted when it is 1, so the filter is present and page is not.
    expect(urlSearch()).not.toContain('page=');
    expect(decodeURIComponent(lastListCall())).toContain('offset=0');
  });

  it('keeps a new page size instead of reverting to the default', async () => {
    setup();
    await waitForFacets();

    fireEvent.change(screen.getByLabelText(/rows per page/i), { target: { value: '100' } });

    await waitFor(() => expect(urlSearch()).toContain('pageSize=100'));
    await waitFor(() => expect(decodeURIComponent(lastListCall())).toContain('limit=100'));
  });

  it('sends no filter parameter when everything is selected again', async () => {
    setup();
    await waitForFacets();

    openFilter('Action');
    fireEvent.click(checkboxFor('login'));
    await waitFor(() => expect(urlSearch()).toContain('actionExclude=login'));

    fireEvent.click(checkboxFor('login'));
    await waitFor(() => expect(urlSearch()).not.toContain('actionExclude'));
    expect(urlSearch()).not.toContain('action=');
  });
});

describe('AdminAuditLogPage select all / select none', () => {
  it('excludes every value on Select none', async () => {
    setup();
    await waitForFacets();

    openFilter('Action');
    fireEvent.click(popover().getByText('Select none'));

    await waitFor(() => expect(urlSearch()).toContain('actionExclude=*'));
  });

  it('clears both parameters on Select all', async () => {
    setup();
    await waitForFacets();

    openFilter('Action');
    fireEvent.click(popover().getByText('Select none'));
    await waitFor(() => expect(urlSearch()).toContain('actionExclude=*'));

    fireEvent.click(popover().getByText('Select all'));
    await waitFor(() => expect(urlSearch()).not.toContain('actionExclude'));
  });
});

describe('AdminAuditLogPage reads existing filter links', () => {
  function renderWith(search) {
    mockMakeAdminApiCall.mockImplementation(url => {
      if (url.startsWith('/admin/audit-log/retention')) {
        return Promise.resolve({ data: { retentionDays: 365, cleanupEnabled: true } });
      }
      return Promise.resolve({ data: { entries: [ENTRY], total: 1, facets: FACETS } });
    });
    return render(
      <MemoryRouter initialEntries={[`/admin/audit-log${search}`]}>
        <AdminAuditLogPage />
        <LocationProbe />
      </MemoryRouter>
    );
  }

  it('honours a legacy single-value inclusion link', async () => {
    renderWith('?resource=app');
    await waitForFacets();

    expect(decodeURIComponent(lastListCall())).toContain('resource=app');
    // Only `app` is ticked, so the trigger reports a partial selection.
    await waitFor(() => expect(triggerFor('Resource')).toHaveTextContent('1 of 2'));
  });

  it('honours an exclusion link', async () => {
    renderWith('?actionExclude=login,create');
    await waitForFacets();

    expect(decodeURIComponent(lastListCall())).toContain('actionExclude=login,create');
    await waitFor(() => expect(triggerFor('Action')).toHaveTextContent('1 of 3'));
  });

  it('reports the select-none state for an exclude-all link', async () => {
    renderWith('?actionExclude=*');
    await waitForFacets();

    await waitFor(() => expect(triggerFor('Action')).toHaveTextContent('No actions'));
  });
});

describe('AdminAuditLogPage quick presets and search', () => {
  it('hides sign-ins with one click and restores them with a second', async () => {
    setup();
    await waitForFacets();

    const chip = screen.getByRole('button', { name: 'Hide sign-ins' });
    expect(chip).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(chip);
    await waitFor(() => expect(decodeURIComponent(urlSearch())).toContain('actionExclude=login'));
    expect(decodeURIComponent(urlSearch())).toContain('logout');
    expect(screen.getByRole('button', { name: 'Hide sign-ins' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    fireEvent.click(screen.getByRole('button', { name: 'Hide sign-ins' }));
    await waitFor(() => expect(urlSearch()).not.toContain('actionExclude'));
  });

  it('filters to failures only and back', async () => {
    setup();
    await waitForFacets();

    fireEvent.click(screen.getByRole('button', { name: 'Failures only' }));
    await waitFor(() => expect(urlSearch()).toContain('result=failure'));
    await waitFor(() => expect(decodeURIComponent(lastListCall())).toContain('result=failure'));

    fireEvent.click(screen.getByRole('button', { name: 'Failures only' }));
    await waitFor(() => expect(urlSearch()).not.toContain('result='));
  });

  it('sends the free-text search term to the server', async () => {
    setup();
    await waitForFacets();

    fireEvent.change(screen.getByLabelText(/Search summary, resource ID/), {
      target: { value: 'chat app' }
    });

    // URLSearchParams encodes the space as '+', on both sides.
    await waitFor(() => expect(urlSearch()).toContain('q=chat+app'));
    await waitFor(() => expect(lastListCall()).toContain('q=chat+app'));
  });

  it('clears every filter at once', async () => {
    setup();
    await waitForFacets();

    fireEvent.click(screen.getByRole('button', { name: 'Hide sign-ins' }));
    await waitFor(() => expect(urlSearch()).toContain('actionExclude'));

    fireEvent.click(screen.getByRole('button', { name: 'Clear all filters' }));
    await waitFor(() => expect(urlSearch()).toBe(''));
  });
});

describe('AdminAuditLogPage keyboard access', () => {
  it('closes the popover on Escape and returns focus to the trigger', async () => {
    setup();
    await waitForFacets();

    const trigger = openFilter('Action');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    fireEvent.keyDown(popover().getByText('Select all'), { key: 'Escape' });

    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
  });

  it('opens the popover from the trigger with ArrowDown', async () => {
    setup();
    await waitForFacets();

    const trigger = triggerFor('Action');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(popover().getByText('login')).toBeInTheDocument();
  });

  it('moves focus between checkboxes with the arrow keys', async () => {
    setup();
    await waitForFacets();

    openFilter('Action');
    const first = checkboxFor('login');
    expect(first).toHaveFocus();

    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(checkboxFor('create')).toHaveFocus();

    fireEvent.keyDown(checkboxFor('create'), { key: 'ArrowUp' });
    expect(first).toHaveFocus();
  });
});
