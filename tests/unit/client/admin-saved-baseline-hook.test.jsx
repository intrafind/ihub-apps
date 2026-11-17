// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * useSavedBaseline with the real useUnsavedChanges: a page that loads in
 * several awaited steps and normalises what it loads is not dirty after the
 * load, an edit makes it dirty, and a partial save (setBaseline(prev => …))
 * only clears the saved block.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { useEffect, useMemo, useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { useSavedBaseline } from '../../../client/src/features/admin/hooks/useSavedBaseline';
import { useUnsavedChanges } from '../../../client/src/features/admin/hooks/useUnsavedChanges';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/** Loads `logging` and `privacy` in three awaited steps, normalising on the way. */
function SettingsPage({ failLoad = false }) {
  const [logging, setLogging] = useState({ level: 'info' });
  const [privacy, setPrivacy] = useState({ redact: false });
  const current = useMemo(() => ({ logging, privacy }), [logging, privacy]);
  const { baseline, captureBaseline, setBaseline } = useSavedBaseline(current);
  const { isDirty } = useUnsavedChanges(baseline, current);

  useEffect(() => {
    (async () => {
      await tick();
      setLogging(prev => ({ ...prev, level: 'debug' }));
      await tick();
      setPrivacy(prev => ({ ...prev, redact: true }));
      await tick();
      if (failLoad) return;
      // Normalised through an updater, as pages do.
      setLogging(prev => ({ ...prev, format: prev.format || 'json' }));
      captureBaseline();
    })();
  }, [captureBaseline, failLoad]);

  return (
    <div>
      <span data-testid="dirty">{String(isDirty)}</span>
      <span data-testid="baseline">{JSON.stringify(baseline)}</span>
      <button type="button" onClick={() => setLogging(prev => ({ ...prev, level: 'warn' }))}>
        edit logging
      </button>
      <button type="button" onClick={() => setPrivacy(prev => ({ ...prev, redact: false }))}>
        edit privacy
      </button>
      <button type="button" onClick={() => setBaseline(prev => ({ ...prev, privacy }))}>
        save privacy
      </button>
      <button type="button" onClick={() => setBaseline(prev => ({ ...prev, logging }))}>
        save logging
      </button>
    </div>
  );
}

async function renderLoaded(props) {
  render(
    <MemoryRouter>
      <SettingsPage {...props} />
    </MemoryRouter>
  );
  await act(async () => {
    for (let i = 0; i < 5; i++) await tick();
  });
}

describe('useSavedBaseline', () => {
  it('captures the normalised value after a multi-step load: not dirty', async () => {
    await renderLoaded();
    expect(JSON.parse(screen.getByTestId('baseline').textContent)).toEqual({
      logging: { level: 'debug', format: 'json' },
      privacy: { redact: true }
    });
    expect(screen.getByTestId('dirty')).toHaveTextContent('false');
  });

  it('an edit after the load is dirty', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByText('edit privacy'));
    expect(screen.getByTestId('dirty')).toHaveTextContent('true');
  });

  it('a partial save clears only that block', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByText('edit logging'));
    fireEvent.click(screen.getByText('edit privacy'));
    fireEvent.click(screen.getByText('save privacy'));
    // Logging is still unsaved.
    expect(screen.getByTestId('dirty')).toHaveTextContent('true');
    fireEvent.click(screen.getByText('save logging'));
    expect(screen.getByTestId('dirty')).toHaveTextContent('false');
  });

  it('stays null and never dirty when the load does not finish', async () => {
    await renderLoaded({ failLoad: true });
    expect(screen.getByTestId('baseline')).toHaveTextContent('null');
    fireEvent.click(screen.getByText('edit privacy'));
    expect(screen.getByTestId('dirty')).toHaveTextContent('false');
  });
});
