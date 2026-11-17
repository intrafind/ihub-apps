// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The component filter of Admin → Logging narrows what is logged to the
 * selected components, but never hides an error of another component
 * (OB-B3): an administrator tracing one component must still see the failure
 * they are looking for. Runs the real logger, in both formats.
 */
import { jest } from '@jest/globals';
import logger, { setConfigCache, reconfigureLogger } from '../utils/logger.js';

/** Log lines written while `fn` runs, whichever way the console transport writes them. */
function capture(fn) {
  const lines = [];
  const collect = chunk => lines.push(String(chunk));
  const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(chunk => {
    collect(chunk);
    return true;
  });
  const consoleStdout = console._stdout
    ? jest.spyOn(console._stdout, 'write').mockImplementation(chunk => {
        collect(chunk);
        return true;
      })
    : null;
  const log = jest.spyOn(console, 'log').mockImplementation(collect);
  try {
    fn();
  } finally {
    stdout.mockRestore();
    consoleStdout?.mockRestore();
    log.mockRestore();
  }
  return lines.join('\n');
}

function useLogging(logging) {
  setConfigCache({ getPlatform: () => ({ logging }) });
  reconfigureLogger();
}

afterAll(() => {
  setConfigCache(null);
  reconfigureLogger();
});

describe.each(['json', 'text'])('the component filter (%s format)', format => {
  beforeEach(() =>
    useLogging({
      level: 'info',
      format,
      components: { enabled: true, filter: ['ChatService'] }
    })
  );

  test('logs every level of a selected component', () => {
    const out = capture(() => {
      logger.info('selected info line', { component: 'ChatService' });
      logger.warn('selected warn line', { component: 'ChatService' });
    });
    expect(out).toContain('selected info line');
    expect(out).toContain('selected warn line');
  });

  test('leaves out info and warnings of the other components', () => {
    const out = capture(() => {
      logger.info('other info line', { component: 'WorkflowEngine' });
      logger.warn('other warn line', { component: 'WorkflowEngine' });
    });
    expect(out).not.toContain('other info line');
    expect(out).not.toContain('other warn line');
  });

  test('never leaves out an error, whatever logged it', () => {
    const out = capture(() => {
      logger.error('other component failed', { component: 'WorkflowEngine' });
      logger.error('failure without a component');
    });
    expect(out).toContain('other component failed');
    expect(out).toContain('failure without a component');
  });
});
