// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { useContext, useState } from 'react';
import {
  BrowserRouter,
  Link,
  MemoryRouter,
  Route,
  Routes,
  UNSAFE_NavigationContext as NavigationContext,
  useLocation,
  useNavigate,
  useSearchParams
} from 'react-router-dom';
import { useUnsavedChanges } from '../../../client/src/features/admin/hooks/useUnsavedChanges';

/**
 * The real useUnsavedChanges hook inside a real router (MemoryRouter for in-app
 * navigation, BrowserRouter on jsdom's history for browser Back/Forward). The app
 * uses a declarative <BrowserRouter>, so that is the router mode under test.
 */

/** An editor with one text field, a guard and controls that navigate. */
function Editor({ name = 'editor', initial = 'saved', onBlocker }) {
  const [value, setValue] = useState(initial);
  const [baseline, setBaseline] = useState(initial);
  const { isDirty, blocker, markSaved } = useUnsavedChanges(baseline, value);
  const navigate = useNavigate();
  const [, setSearchParams] = useSearchParams();
  if (onBlocker) onBlocker(blocker);
  return (
    <div data-testid={name}>
      <input aria-label={`${name}-field`} value={value} onChange={e => setValue(e.target.value)} />
      <span data-testid={`${name}-dirty`}>{String(isDirty)}</span>
      <span data-testid={`${name}-blocker`}>{blocker.state}</span>
      <Link to="/other">{`${name}-link`}</Link>
      <button type="button" onClick={() => navigate('/other', { replace: true })}>
        {`${name}-replace`}
      </button>
      <button type="button" onClick={() => navigate(-1)}>
        {`${name}-back`}
      </button>
      <button type="button" onClick={() => setSearchParams({ tab: 'b' }, { replace: true })}>
        {`${name}-tab`}
      </button>
      <button type="button" onClick={() => setSearchParams({ tab: 'c' })}>
        {`${name}-push-tab`}
      </button>
      <button
        type="button"
        onClick={() => {
          setBaseline(value);
          markSaved();
          navigate('/other');
        }}
      >
        {`${name}-save-and-leave`}
      </button>
      {blocker.state === 'blocked' && (
        <div role="alertdialog" aria-label={`${name}-prompt`}>
          <button type="button" onClick={blocker.proceed}>
            Discard changes
          </button>
          <button type="button" onClick={blocker.reset}>
            Stay
          </button>
        </div>
      )}
    </div>
  );
}

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname + location.search}</span>;
}

function renderInMemory(element, initialEntries = ['/start', '/edit']) {
  return render(
    <MemoryRouter initialEntries={initialEntries} initialIndex={initialEntries.length - 1}>
      <Routes>
        <Route path="/edit" element={element} />
        <Route path="/start" element={<p>start page</p>} />
        <Route path="/other" element={<p>other page</p>} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>
  );
}

function type(name, value) {
  fireEvent.change(screen.getByLabelText(`${name}-field`), { target: { value } });
}

describe('useUnsavedChanges (real hook, real router)', () => {
  it('lets a link navigate while the page is clean', () => {
    renderInMemory(<Editor />);
    fireEvent.click(screen.getByText('editor-link'));
    expect(screen.getByText('other page')).toBeInTheDocument();
  });

  it('blocks a link (push) while dirty; Stay keeps the edit, Discard navigates', () => {
    renderInMemory(<Editor />);
    type('editor', 'saved!');
    expect(screen.getByTestId('editor-dirty')).toHaveTextContent('true');

    fireEvent.click(screen.getByText('editor-link'));
    expect(screen.getByTestId('location')).toHaveTextContent('/edit');
    expect(screen.getByTestId('editor-blocker')).toHaveTextContent('blocked');

    fireEvent.click(screen.getByText('Stay'));
    expect(screen.getByTestId('editor-blocker')).toHaveTextContent('unblocked');
    expect(screen.getByLabelText('editor-field')).toHaveValue('saved!');

    fireEvent.click(screen.getByText('editor-link'));
    fireEvent.click(screen.getByText('Discard changes'));
    expect(screen.getByText('other page')).toBeInTheDocument();
  });

  it('blocks navigate(path, { replace: true }) while dirty', () => {
    renderInMemory(<Editor />);
    type('editor', 'x');
    fireEvent.click(screen.getByText('editor-replace'));
    expect(screen.getByTestId('location')).toHaveTextContent('/edit');
    expect(screen.getByTestId('editor-blocker')).toHaveTextContent('blocked');
    fireEvent.click(screen.getByText('Discard changes'));
    expect(screen.getByText('other page')).toBeInTheDocument();
  });

  it('blocks navigate(-1) while dirty and performs it on Discard', () => {
    renderInMemory(<Editor />);
    type('editor', 'x');
    fireEvent.click(screen.getByText('editor-back'));
    expect(screen.getByTestId('location')).toHaveTextContent('/edit');
    expect(screen.getByTestId('editor-blocker')).toHaveTextContent('blocked');
    fireEvent.click(screen.getByText('Discard changes'));
    expect(screen.getByText('start page')).toBeInTheDocument();
  });

  it('does not block a query-only change on the same page (tabs, filters)', () => {
    renderInMemory(<Editor />);
    type('editor', 'x');
    fireEvent.click(screen.getByText('editor-tab'));
    expect(screen.getByTestId('location')).toHaveTextContent('/edit?tab=b');
    expect(screen.getByTestId('editor-blocker')).toHaveTextContent('unblocked');
    expect(screen.getByLabelText('editor-field')).toHaveValue('x');
  });

  it('lets markSaved() then navigate() in the same handler through', () => {
    renderInMemory(<Editor />);
    type('editor', 'x');
    fireEvent.click(screen.getByText('editor-save-and-leave'));
    expect(screen.getByText('other page')).toBeInTheDocument();
  });

  it('is never dirty while the baseline is null (loading or load failed)', () => {
    function Loading() {
      const { isDirty } = useUnsavedChanges(null, { a: 1 });
      return <span data-testid="dirty">{String(isDirty)}</span>;
    }
    renderInMemory(<Loading />);
    expect(screen.getByTestId('dirty')).toHaveTextContent('false');
  });

  it('adds a beforeunload handler only while dirty', () => {
    renderInMemory(<Editor />);
    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    type('editor', 'x');
    const dirty = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);

    type('editor', 'saved');
    const cleanAgain = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(cleanAgain);
    expect(cleanAgain.defaultPrevented).toBe(false);
  });

  it('two guards on one page produce one prompt and one navigation', () => {
    renderInMemory(
      <>
        <Editor name="outer" />
        <Editor name="inner" />
      </>
    );
    type('outer', 'x');
    type('inner', 'y');
    fireEvent.click(screen.getByText('inner-link'));
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    fireEvent.click(screen.getByText('Discard changes'));
    expect(screen.getByText('other page')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('restores the navigator methods when the last guard unmounts', () => {
    let navigator;
    function Grab() {
      navigator = useContext(NavigationContext).navigator;
      return null;
    }
    function Host({ guards }) {
      return (
        <>
          <Grab />
          {guards >= 1 && <Editor name="a" />}
          {guards >= 2 && <Editor name="b" />}
        </>
      );
    }
    const { rerender } = render(
      <MemoryRouter initialEntries={['/edit']}>
        <Host guards={0} />
      </MemoryRouter>
    );
    const original = { push: navigator.push, replace: navigator.replace, go: navigator.go };

    rerender(
      <MemoryRouter initialEntries={['/edit']}>
        <Host guards={2} />
      </MemoryRouter>
    );
    expect(navigator.push).not.toBe(original.push);
    const patched = navigator.push;

    rerender(
      <MemoryRouter initialEntries={['/edit']}>
        <Host guards={1} />
      </MemoryRouter>
    );
    // One guard left: still the same single interceptor, not a new layer.
    expect(navigator.push).toBe(patched);

    rerender(
      <MemoryRouter initialEntries={['/edit']}>
        <Host guards={0} />
      </MemoryRouter>
    );
    expect(navigator.push).toBe(original.push);
    expect(navigator.replace).toBe(original.replace);
    expect(navigator.go).toBe(original.go);
  });
});

describe('useUnsavedChanges and browser Back/Forward (POP)', () => {
  function BrowserApp() {
    return (
      <BrowserRouter>
        <Routes>
          <Route path="/edit" element={<Editor />} />
          <Route path="/start" element={<Link to="/edit">open editor</Link>} />
        </Routes>
        <LocationProbe />
      </BrowserRouter>
    );
  }

  beforeEach(() => {
    window.history.replaceState({ usr: null, key: 'start', idx: 0 }, '', '/start');
  });

  it('lets Back through while the page is clean', async () => {
    render(<BrowserApp />);
    fireEvent.click(screen.getByText('open editor'));
    expect(screen.getByTestId('location')).toHaveTextContent('/edit');

    act(() => window.history.back());
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/start'));
  });

  it('blocks Back while dirty, keeps the page, and Discard then goes back', async () => {
    render(<BrowserApp />);
    fireEvent.click(screen.getByText('open editor'));
    type('editor', 'x');

    act(() => window.history.back());
    await waitFor(() => expect(screen.getByTestId('editor-blocker')).toHaveTextContent('blocked'));
    // The router never left the page and the browser URL is back on /edit.
    await waitFor(() => expect(window.location.pathname).toBe('/edit'));
    expect(screen.getByTestId('location')).toHaveTextContent('/edit');
    expect(screen.getByLabelText('editor-field')).toHaveValue('x');

    fireEvent.click(screen.getByText('Discard changes'));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/start'));
    expect(window.location.pathname).toBe('/start');
  });

  it('Stay after a blocked Back keeps the edit and the next Back asks again', async () => {
    render(<BrowserApp />);
    fireEvent.click(screen.getByText('open editor'));
    type('editor', 'x');

    act(() => window.history.back());
    await waitFor(() => expect(screen.getByTestId('editor-blocker')).toHaveTextContent('blocked'));
    await waitFor(() => expect(window.location.pathname).toBe('/edit'));
    fireEvent.click(screen.getByText('Stay'));
    expect(screen.getByLabelText('editor-field')).toHaveValue('x');

    act(() => window.history.back());
    await waitFor(() => expect(screen.getByTestId('editor-blocker')).toHaveTextContent('blocked'));
    await waitFor(() => expect(window.location.pathname).toBe('/edit'));
    expect(screen.getByTestId('location')).toHaveTextContent('/edit');
  });

  it('lets a Back that stays on the same page through (a pushed tab or filter)', async () => {
    render(<BrowserApp />);
    fireEvent.click(screen.getByText('open editor'));
    type('editor', 'x');
    fireEvent.click(screen.getByText('editor-push-tab'));
    expect(screen.getByTestId('location')).toHaveTextContent('/edit?tab=c');

    act(() => window.history.back());
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/edit$/));
    expect(screen.getByTestId('editor-blocker')).toHaveTextContent('unblocked');
    expect(screen.getByLabelText('editor-field')).toHaveValue('x');
  });

  it('lets navigate(-1) back to a same-page entry through (closing a pushed pane)', async () => {
    render(<BrowserApp />);
    fireEvent.click(screen.getByText('open editor'));
    type('editor', 'x');
    // Like ArtifactViewerHost: open a pane with a pushed `?pane=…`, close it with navigate(-1).
    fireEvent.click(screen.getByText('editor-push-tab'));
    expect(screen.getByTestId('location')).toHaveTextContent('/edit?tab=c');

    fireEvent.click(screen.getByText('editor-back'));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/edit$/));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByLabelText('editor-field')).toHaveValue('x');
  });

  it('still blocks navigate(-1) to another page after a same-page entry was closed', async () => {
    render(<BrowserApp />);
    fireEvent.click(screen.getByText('open editor'));
    type('editor', 'x');
    fireEvent.click(screen.getByText('editor-push-tab'));
    fireEvent.click(screen.getByText('editor-back'));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/edit$/));

    // The next step back leaves the editor for /start.
    fireEvent.click(screen.getByText('editor-back'));
    expect(screen.getByTestId('editor-blocker')).toHaveTextContent('blocked');
    expect(screen.getByTestId('location')).toHaveTextContent('/edit');
  });

  it('lets a POP through when the target entry has no router index (fails open)', async () => {
    render(<BrowserApp />);
    fireEvent.click(screen.getByText('open editor'));
    type('editor', 'x');

    // An entry the router did not create: history.state carries no `idx`.
    act(() => {
      window.history.pushState(null, '', '/start');
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    });
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/start'));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('Discard on a held navigate(-1) drops the beforeunload prompt before the jump', async () => {
    render(<BrowserApp />);
    fireEvent.click(screen.getByText('open editor'));
    type('editor', 'x');
    fireEvent.click(screen.getByText('editor-back'));
    expect(screen.getByTestId('editor-blocker')).toHaveTextContent('blocked');

    fireEvent.click(screen.getByText('Discard changes'));
    // The jump has not happened yet (history traversal is asynchronous). If it
    // leaves the document, the browser must not ask a second time.
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/start'));
  });

  it('leaves Back alone on pages without a guard', async () => {
    render(
      <BrowserRouter>
        <Routes>
          <Route path="/start" element={<Link to="/plain">open plain</Link>} />
          <Route path="/plain" element={<p>plain page</p>} />
        </Routes>
        <LocationProbe />
      </BrowserRouter>
    );
    fireEvent.click(screen.getByText('open plain'));
    act(() => window.history.back());
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/start'));
  });
});
