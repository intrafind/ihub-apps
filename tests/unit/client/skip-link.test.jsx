import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom';

/**
 * SkipLink — the "skip to content" link must move focus to its target without
 * navigating, even when index.html has injected a <base> element (which makes a
 * bare "#id" resolve against the app root instead of the current page).
 */
const SkipLink = require('../../../client/src/shared/components/SkipLink').default;

function renderPage(initialEntry = '/admin/apps') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <SkipLink targetId="main-content" className="sr-only">
        Skip to main content
      </SkipLink>
      <nav>
        <a href="/elsewhere">Elsewhere</a>
      </nav>
      <main id="main-content" tabIndex={-1}>
        content
      </main>
    </MemoryRouter>
  );
}

describe('SkipLink', () => {
  let base;

  beforeEach(() => {
    base = document.createElement('base');
    base.href = 'http://localhost/';
    document.head.appendChild(base);
  });

  afterEach(() => {
    base.remove();
  });

  it('moves focus to the target and cancels the default navigation', () => {
    renderPage();
    const link = screen.getByRole('link', { name: 'Skip to main content' });

    // fireEvent returns false when the click's default action was prevented.
    const notPrevented = fireEvent.click(link);

    expect(notPrevented).toBe(false);
    expect(document.getElementById('main-content')).toHaveFocus();
  });

  it('keeps the current page in its href instead of resolving to the base URL', () => {
    renderPage();
    const href = screen.getByRole('link', { name: 'Skip to main content' }).getAttribute('href');

    expect(href).toBe(`${window.location.pathname}${window.location.search}#main-content`);
    expect(href.startsWith('#')).toBe(false);
  });

  it('lets the click through when the target is missing', () => {
    render(
      <MemoryRouter>
        <SkipLink targetId="does-not-exist">Skip</SkipLink>
      </MemoryRouter>
    );

    expect(fireEvent.click(screen.getByRole('link', { name: 'Skip' }))).toBe(true);
  });
});
