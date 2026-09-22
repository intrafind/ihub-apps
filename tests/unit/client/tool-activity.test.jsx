/**
 * What a chat turn searched for, found and read before it answered: the
 * projection (client/src/features/chat/toolActivity.js, via runToMessage) and
 * the component that shows it (ToolActivity.jsx). Issue #2480.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import {
  createStreamState,
  reduceRunEvents,
  getRun
} from '../../../client/src/shared/run/runReducer';
import { projectRunToMessage } from '../../../client/src/features/chat/runToMessage';
import {
  buildToolActivity,
  searchScope,
  toolKind
} from '../../../client/src/features/chat/toolActivity';
import ToolActivity from '../../../client/src/features/chat/components/ToolActivity';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultOrOptions, maybeOptions) => {
      const options = typeof defaultOrOptions === 'object' ? defaultOrOptions : maybeOptions || {};
      if (typeof defaultOrOptions !== 'string') {
        return options.count !== undefined ? `${key}:${options.count}` : key;
      }
      return Object.entries(options).reduce(
        (text, [name, value]) => text.replace(`{{${name}}}`, value),
        defaultOrOptions
      );
    }
  })
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: ({ name }) => <span data-testid="icon" data-name={name} />
}));

const ts = seq => `2026-09-22T10:00:${String(seq).padStart(2, '0')}.000Z`;
const env = (seq, type, data = {}, runId = 'run-1') => ({
  v: 2,
  seq,
  runId,
  ts: ts(seq),
  type,
  data
});
const started = env(1, 'run/started', {
  kind: 'chat',
  refs: { chatId: 'chat-1', appId: 'app-1', messageId: 'msg-1' }
});
const ended = seq => env(seq, 'run/ended', { status: 'completed', finishReason: 'stop' });

function runFrom(envelopes) {
  return getRun(reduceRunEvents(createStreamState('chat-1'), envelopes), 'run-1');
}

const searchStarted = (seq, callId = 'c1', query = 'berlin weather') =>
  env(seq, 'tool/started', {
    step: 1,
    callId,
    toolId: 'braveSearch',
    name: 'braveSearch',
    args: { query, extractContent: true },
    execution: 'server'
  });

const webSources = [
  { url: 'https://weather.example/berlin', title: 'Berlin weather', read: true },
  { url: 'https://news.example/', title: 'News', readFailed: true },
  { url: 'https://other.example/' }
];

const searchCompleted = (seq, callId = 'c1') =>
  env(seq, 'tool/completed', {
    step: 1,
    callId,
    toolId: 'braveSearch',
    name: 'braveSearch',
    resultPreview: '{"query":"berlin weather"…[truncated]',
    durationMs: 800,
    webSources
  });

describe('toolKind', () => {
  test('classifies search, fetch and other tools', () => {
    expect(toolKind('braveSearch')).toBe('search');
    expect(toolKind('source_handbook')).toBe('search');
    expect(toolKind('webContentExtractor')).toBe('fetch');
    expect(toolKind('jira')).toBe('tool');
  });
});

describe('searchScope', () => {
  test('iFinder and configured sources search documents, not the web', () => {
    expect(searchScope('iFinder_search')).toBe('documents');
    expect(searchScope('source_handbook')).toBe('documents');
    expect(searchScope('braveSearch')).toBe('web');
  });
});

describe('buildToolActivity', () => {
  test('a turn without tools has no activity', () => {
    const run = runFrom([started, env(2, 'step/delta', { step: 1, kind: 'text', content: 'Hi' })]);
    expect(buildToolActivity(run)).toBeNull();
    expect(projectRunToMessage(run).extras.toolActivity).toBeUndefined();
  });

  test('a running search shows its query and the page being read', () => {
    const run = runFrom([
      started,
      searchStarted(2),
      env(3, 'tool/progress', { phase: 'search', data: { query: 'berlin weather' } }),
      env(4, 'tool/progress', {
        phase: 'fetch.loading',
        toolId: 'webContentExtractor',
        data: { url: 'https://weather.example/berlin', status: 'loading' }
      })
    ]);
    const activity = projectRunToMessage(run).extras.toolActivity;
    expect(activity.items).toHaveLength(1);
    expect(activity.items[0]).toMatchObject({
      id: 'c1',
      kind: 'search',
      status: 'running',
      query: 'berlin weather',
      sources: []
    });
    expect(activity.reading).toBe('https://weather.example/berlin');
  });

  test('a completed search carries the sources the server reported', () => {
    const run = runFrom([started, searchStarted(2), searchCompleted(3), ended(4)]);
    const activity = buildToolActivity(run);
    expect(activity.reading).toBeNull();
    expect(activity.items[0]).toMatchObject({
      status: 'completed',
      sources: webSources,
      durationMs: 800
    });
  });

  test('clarifications, workflows and skill activation are left to their own UI', () => {
    const run = runFrom([
      started,
      env(2, 'tool/started', {
        step: 1,
        callId: 'q',
        toolId: 'ask_user',
        name: 'ask_user',
        args: {},
        execution: 'clarification'
      }),
      env(3, 'tool/started', {
        step: 1,
        callId: 'w',
        toolId: 'workflow_x',
        name: 'workflow_x',
        args: {},
        execution: 'passthrough'
      }),
      env(4, 'tool/started', {
        step: 1,
        callId: 's',
        toolId: 'activate_skill',
        name: 'activate_skill',
        args: {},
        execution: 'server'
      }),
      env(5, 'tool/started', {
        step: 1,
        callId: 'j',
        toolId: 'jira',
        name: 'jira',
        args: {},
        execution: 'server'
      })
    ]);
    const activity = buildToolActivity(run);
    expect(activity.items.map(item => item.id)).toEqual(['j']);
    expect(activity.items[0].kind).toBe('tool');
  });

  test('a call that never finished reads as stopped once the turn is over', () => {
    const run = runFrom([
      started,
      searchStarted(2),
      env(3, 'run/ended', { status: 'aborted', finishReason: 'connection_closed' })
    ]);
    expect(buildToolActivity(run).items[0].status).toBe('stopped');
  });

  test('provider-run web search reports its queries, deduplicated', () => {
    const run = runFrom([
      started,
      env(2, 'tool/progress', {
        phase: 'grounding',
        data: { webSearchQueries: ['berlin weather'], groundingChunks: [] }
      }),
      env(3, 'tool/progress', {
        phase: 'grounding',
        data: { webSearchQueries: ['berlin weather', 'berlin forecast'] }
      })
    ]);
    const [native] = buildToolActivity(run).items;
    expect(native).toMatchObject({
      kind: 'search',
      native: true,
      status: 'running',
      queries: ['berlin weather', 'berlin forecast']
    });
  });
});

describe('ToolActivity', () => {
  const finished = () =>
    buildToolActivity(runFrom([started, searchStarted(2), searchCompleted(3), ended(4)]));

  test('is open while the answer streams', () => {
    const running = buildToolActivity(runFrom([started, searchStarted(2)]));
    render(<ToolActivity activity={running} loading />);
    const toggle = screen.getByRole('button');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveTextContent('Searching for “berlin weather”');
    expect(screen.getByText('berlin weather')).toBeInTheDocument();
  });

  test('collapses to a summary once the answer is complete, and expands on click', () => {
    render(<ToolActivity activity={finished()} loading={false} />);
    const toggle = screen.getByRole('button');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveTextContent(
      'Searched the web · toolActivity.searches:1 · toolActivity.sources:3 · toolActivity.pagesRead:1'
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const links = screen.getAllByRole('link');
    expect(links.map(link => link.getAttribute('href'))).toEqual(webSources.map(s => s.url));
    expect(links[0]).toHaveAttribute('target', '_blank');
    expect(links[0]).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText('Berlin weather')).toBeInTheDocument();
    // A source without a title is shown by its host.
    expect(screen.getByText('other.example')).toBeInTheDocument();
    // Which pages were read, and which could not be.
    expect(screen.getByText('Read')).toBeInTheDocument();
    expect(screen.getByText('Not readable')).toBeInTheDocument();
  });

  test('an iFinder search is a document search, not a web search', () => {
    const toolId = 'iFinder_search';
    const activity = buildToolActivity(
      runFrom([
        started,
        env(2, 'tool/started', {
          step: 1,
          callId: 'c1',
          toolId,
          name: toolId,
          args: { query: 'supplier contracts' },
          execution: 'server'
        }),
        env(3, 'tool/completed', {
          step: 1,
          callId: 'c1',
          toolId,
          name: toolId,
          durationMs: 300,
          webSources: [{ url: 'https://ifinder.example/doc/1', title: 'Contract A' }]
        }),
        ended(4)
      ])
    );
    expect(activity.items[0]).toMatchObject({ kind: 'search', scope: 'documents' });
    render(<ToolActivity activity={activity} loading={false} />);
    const toggle = screen.getByRole('button');
    expect(toggle).toHaveTextContent(
      'Searched documents · toolActivity.searches:1 · toolActivity.sources:1'
    );
    expect(toggle).not.toHaveTextContent('Searched the web');
    expect(screen.getAllByTestId('icon')[0]).toHaveAttribute('data-name', 'document-text');
  });

  test('an iFinder_getContent call says which document it read', () => {
    const tool = (seq, type, callId, toolId, data) =>
      env(seq, type, { step: 1, callId, toolId, name: toolId, ...data });
    const doc = {
      url: 'https://ifinder.example/doc/1',
      documentId: 'doc-1',
      title: 'Contract A'
    };
    const activity = buildToolActivity(
      runFrom([
        started,
        tool(2, 'tool/started', 'c1', 'iFinder_search', {
          args: { query: 'supplier contracts' },
          execution: 'server'
        }),
        tool(3, 'tool/completed', 'c1', 'iFinder_search', {
          durationMs: 300,
          webSources: [doc, { documentId: 'doc-2', title: 'Contract B' }]
        }),
        tool(4, 'tool/started', 'c2', 'iFinder_getContent', {
          args: { documentId: 'doc-1' },
          execution: 'server'
        }),
        // The content result has no browser link of its own.
        tool(5, 'tool/completed', 'c2', 'iFinder_getContent', {
          durationMs: 200,
          webSources: [{ documentId: 'doc-1', title: 'Contract A', read: true }]
        }),
        ended(6)
      ])
    );
    const [search, read] = activity.items;
    expect(read).toMatchObject({ kind: 'fetch', scope: 'documents', documentId: 'doc-1' });
    // The hit that found the document is marked read.
    expect(search.sources[0]).toMatchObject({ documentId: 'doc-1', read: true });
    expect(search.sources[1].read).toBeUndefined();

    render(<ToolActivity activity={activity} loading={false} />);
    const toggle = screen.getByRole('button');
    expect(toggle).toHaveTextContent(
      'Searched documents · toolActivity.searches:1 · toolActivity.sources:2 · toolActivity.documentsRead:1'
    );
    fireEvent.click(toggle);
    // The read links to the document via the search hit's deep link.
    const links = screen.getAllByRole('link', { name: 'Contract A' });
    expect(links.map(link => link.getAttribute('href'))).toEqual([doc.url, doc.url]);
    // A hit without a browser link is still listed by title.
    expect(screen.getByText('Contract B')).toBeInTheDocument();
  });

  test('renders nothing without activity', () => {
    const { container } = render(<ToolActivity activity={{ items: [], reading: null }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
