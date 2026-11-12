/**
 * What a chat turn searched for, found and read before it answered: the
 * projection (client/src/features/chat/toolActivity.js, via runToMessage) and
 * the component that shows it (ToolActivity.jsx). Issue #2480.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  within
} from '@testing-library/react';
import '@testing-library/jest-dom';
import { createStreamState, reduceRunEvents, getRun } from '../../../shared/run/runReducer.js';
import { projectRunToMessage } from '../../../client/src/features/chat/runToMessage';
import { buildToolActivity, toolDetails } from '../../../shared/run/toolActivity.js';
import ToolActivity from '../../../client/src/features/chat/components/ToolActivity';
import {
  BusyIcon,
  formatClock,
  formatSize
} from '../../../client/src/features/chat/components/ActivityProgress';
import { useGracedActivity } from '../../../client/src/features/chat/hooks/useGracedActivity';
import {
  elapsedAt,
  isPainted,
  isStalled,
  paintsIn
} from '../../../client/src/features/chat/activityTiming.js';
import {
  headlineModeOf,
  isActivityLineBusy
} from '../../../client/src/features/chat/activityHeadline.js';
import { buildRunActivity } from '../../../shared/run/runActivity.js';
import { withServerDecision } from './helpers/serverToolDecision.js';

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
  default: ({ name, className }) => (
    <span data-testid="icon" data-name={name} className={className} />
  )
}));

const ts = seq => `2026-09-22T10:00:${String(seq).padStart(2, '0')}.000Z`;
const env = (seq, type, data = {}, runId = 'run-1') => ({
  v: 2,
  seq,
  runId,
  ts: ts(seq),
  type,
  data: withServerDecision(type, data)
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

/** What the search found, as the server reports it (`sources/added`, shared/sources). */
const webSources = [
  {
    id: 'url:weather.example/berlin',
    provider: 'web',
    kind: 'page',
    url: 'https://weather.example/berlin',
    title: 'Berlin weather',
    read: { ok: true },
    private: false
  },
  {
    id: 'url:news.example',
    provider: 'web',
    kind: 'page',
    url: 'https://news.example/',
    title: 'News',
    read: { ok: false },
    private: false
  },
  {
    id: 'url:other.example',
    provider: 'web',
    kind: 'page',
    url: 'https://other.example/',
    private: false
  }
];

const searchCompleted = (seq, callId = 'c1') =>
  env(seq, 'tool/completed', {
    step: 1,
    callId,
    toolId: 'braveSearch',
    name: 'braveSearch',
    resultPreview: '{"query":"berlin weather"…[truncated]',
    durationMs: 800
  });

const searchFound = (seq, callId = 'c1') =>
  env(seq, 'sources/added', {
    step: 1,
    callId,
    toolId: 'braveSearch',
    items: webSources,
    queries: ['berlin weather']
  });

describe('row kind and scope', () => {
  // The server decides them (server/utils/toolDisplay.js); the client infers nothing from the id.
  const rowOf = data =>
    buildToolActivity(
      runFrom([
        started,
        // Raw, not through `env`: the frame carries exactly what each case gives.
        {
          v: 2,
          seq: 2,
          runId: 'run-1',
          ts: ts(2),
          type: 'tool/started',
          data: {
            step: 1,
            callId: 'c1',
            name: 'x',
            args: { query: 'q' },
            execution: 'server',
            ...data
          }
        }
      ])
    ).items[0];

  test('a call is drawn as the server says', () => {
    expect(
      rowOf({ toolId: 'anything', activityKind: 'search', activityScope: 'documents' })
    ).toMatchObject({ kind: 'search', scope: 'documents', query: 'q' });
    expect(
      rowOf({ toolId: 'anything', activityKind: 'fetch', activityScope: 'web' })
    ).toMatchObject({ kind: 'fetch', scope: 'web' });
  });

  test('a call the server said nothing about is a plain call, whatever its id', () => {
    expect(rowOf({ toolId: 'braveSearch' })).toMatchObject({
      kind: 'tool',
      scope: null,
      query: null
    });
    expect(rowOf({ toolId: 'jira_searchTickets', activityKind: 'tool' })).toMatchObject({
      kind: 'tool'
    });
  });
});

describe('toolDetails', () => {
  test('lists every argument but the ones the row shows, one value per array element', () => {
    expect(
      toolDetails(
        {
          query: '*',
          filter: ['creators.keyword:"Daniel Manzke"', 'modificationDate:[2026-09-09 TO *]'],
          sort: ['modificationDate:desc'],
          maxResults: 20,
          from: 0,
          exact: false,
          searchProfile: null,
          returnFacets: []
        },
        ['query']
      )
    ).toEqual([
      {
        name: 'filter',
        values: [
          { text: 'creators.keyword:"Daniel Manzke"' },
          { text: 'modificationDate:[2026-09-09 TO *]' }
        ],
        more: 0
      },
      { name: 'sort', values: [{ text: 'modificationDate:desc' }], more: 0 },
      { name: 'maxResults', values: [{ text: '20' }], more: 0 },
      { name: 'from', values: [{ text: '0' }], more: 0 },
      { name: 'exact', values: [{ text: 'false' }], more: 0 }
    ]);
  });

  test('cuts a long value and keeps the full text', () => {
    const long = 'x'.repeat(200);
    const [detail] = toolDetails({ note: long, options: { deep: true } });
    expect(detail.values[0].text).toBe(`${'x'.repeat(160)}…`);
    expect(detail.values[0].full).toBe(long);
    expect(toolDetails({ options: { deep: true } })[0].values).toEqual([{ text: '{"deep":true}' }]);
  });

  test('lists a long array by its first values and counts the rest, without repeats', () => {
    const fields = Array.from({ length: 30 }, (_, i) => `field${i}`);
    const [detail] = toolDetails({ returnFields: [...fields, 'field0'] });
    expect(detail.values).toHaveLength(12);
    expect(detail.values[0]).toEqual({ text: 'field0' });
    expect(detail.more).toBe(18);
    const item = { id: 'c1', kind: 'tool', name: 'iFinder_search', status: 'completed' };
    render(
      <ToolActivity
        activity={{ items: [{ ...item, details: [detail], sources: [] }], reading: null }}
      />
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('toolActivity.moreValues:18')).toBeInTheDocument();
  });

  test('has nothing to list without arguments', () => {
    expect(toolDetails(undefined)).toEqual([]);
    expect(toolDetails({})).toEqual([]);
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
        toolId: 'read_url',
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
    const run = runFrom([started, searchStarted(2), searchCompleted(3), searchFound(4), ended(5)]);
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
    buildToolActivity(
      runFrom([started, searchStarted(2), searchCompleted(3), searchFound(4), ended(5)])
    );

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
      'Searched the web · toolActivity.searches:1 · toolActivity.results:3 · toolActivity.pagesRead:1'
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
          durationMs: 300
        }),
        env(4, 'sources/added', {
          step: 1,
          callId: 'c1',
          toolId,
          items: [
            {
              id: 'ifinder:doc-1',
              provider: 'ifinder',
              kind: 'document',
              url: 'https://ifinder.example/doc/1',
              title: 'Contract A',
              ref: { id: 'doc-1' },
              private: true
            }
          ]
        }),
        ended(5)
      ])
    );
    expect(activity.items[0]).toMatchObject({ kind: 'search', scope: 'documents' });
    render(<ToolActivity activity={activity} loading={false} />);
    const toggle = screen.getByRole('button');
    expect(toggle).toHaveTextContent(
      'Searched documents · toolActivity.searches:1 · toolActivity.results:1'
    );
    expect(toggle).not.toHaveTextContent('Searched the web');
    expect(screen.getAllByTestId('icon')[0]).toHaveAttribute('data-name', 'document-text');
  });

  test('an iFinder_getContent call says which document it read', () => {
    const tool = (seq, type, callId, toolId, data) =>
      env(seq, type, { step: 1, callId, toolId, name: toolId, ...data });
    const docSource = id => ({
      id: `ifinder:${id}`,
      provider: 'ifinder',
      kind: 'document',
      ref: { id },
      private: true
    });
    const doc = {
      ...docSource('doc-1'),
      url: 'https://ifinder.example/doc/1',
      title: 'Contract A'
    };
    const activity = buildToolActivity(
      runFrom([
        started,
        tool(2, 'tool/started', 'c1', 'iFinder_search', {
          args: { query: 'supplier contracts' },
          execution: 'server'
        }),
        tool(3, 'tool/completed', 'c1', 'iFinder_search', { durationMs: 300 }),
        tool(4, 'sources/added', 'c1', 'iFinder_search', {
          items: [doc, { ...docSource('doc-2'), title: 'Contract B' }]
        }),
        tool(5, 'tool/started', 'c2', 'iFinder_getContent', {
          args: { documentId: 'doc-1' },
          execution: 'server'
        }),
        tool(6, 'tool/completed', 'c2', 'iFinder_getContent', { durationMs: 200 }),
        // The content result has no browser link of its own.
        tool(7, 'sources/added', 'c2', 'iFinder_getContent', {
          items: [{ ...docSource('doc-1'), title: 'Contract A', read: { ok: true } }]
        }),
        ended(8)
      ])
    );
    const [search, read] = activity.items;
    expect(read).toMatchObject({ kind: 'fetch', scope: 'documents', documentId: 'doc-1' });
    // The hit that found the document is marked read.
    expect(search.sources[0]).toMatchObject({ ref: { id: 'doc-1' }, read: { ok: true } });
    expect(search.sources[1].read).toBeUndefined();

    render(<ToolActivity activity={activity} loading={false} />);
    const toggle = screen.getByRole('button');
    expect(toggle).toHaveTextContent(
      'Searched documents · toolActivity.searches:1 · toolActivity.results:2 · toolActivity.documentsRead:1'
    );
    fireEvent.click(toggle);
    // The read links to the document via the search hit's deep link.
    const links = screen.getAllByRole('link', { name: 'Contract A' });
    expect(links.map(link => link.getAttribute('href'))).toEqual([doc.url, doc.url]);
    // A hit without a browser link is still listed by title.
    expect(screen.getByText('Contract B')).toBeInTheDocument();
  });

  const call = (seq, type, callId, toolId, data) =>
    env(seq, type, { step: 1, callId, toolId, name: toolId, ...data });

  test('shows what each call asked for: filters, sort, facets', () => {
    const activity = buildToolActivity(
      runFrom([
        started,
        call(2, 'tool/started', 'c1', 'iFinder_search', {
          args: {
            query: '*',
            filter: ['creators.keyword:"Daniel Manzke"'],
            sort: ['modificationDate:desc'],
            maxResults: 20
          },
          execution: 'server'
        }),
        call(3, 'tool/completed', 'c1', 'iFinder_search', { durationMs: 300 }),
        call(4, 'tool/started', 'c2', 'iFinder_getFacetValues', {
          args: { facet: 'creators.keyword', query: 'Manzke' },
          execution: 'server'
        }),
        call(5, 'tool/completed', 'c2', 'iFinder_getFacetValues', { durationMs: 100 }),
        ended(6)
      ])
    );
    // The query is the search row's own chip, not repeated as a detail.
    expect(activity.items[0].details.map(detail => detail.name)).toEqual([
      'filter',
      'sort',
      'maxResults'
    ]);
    render(<ToolActivity activity={activity} loading={false} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('creators.keyword:"Daniel Manzke"')).toBeInTheDocument();
    expect(screen.getByText('modificationDate:desc')).toBeInTheDocument();
    expect(screen.getByText('20')).toBeInTheDocument();
    // A tool without a query of its own lists all of its arguments.
    expect(screen.getByText('Ran iFinder_getFacetValues')).toBeInTheDocument();
    expect(screen.getByText('facet')).toBeInTheDocument();
    expect(screen.getByText('creators.keyword')).toBeInTheDocument();
    expect(screen.getByText('Manzke')).toBeInTheDocument();
  });

  test('a failed call shows why, not only on hover', () => {
    const activity = buildToolActivity(
      runFrom([
        started,
        call(2, 'tool/started', 'c1', 'iFinder_getContent', {
          args: { documentId: 'IPD-531' },
          execution: 'server'
        }),
        call(3, 'tool/completed', 'c1', 'iFinder_getContent', {
          durationMs: 100,
          error: { message: 'Document not found: IPD-531' }
        }),
        ended(4)
      ])
    );
    // The document id is the row's label, not a detail.
    expect(activity.items[0].details).toEqual([]);
    render(<ToolActivity activity={activity} loading={false} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('IPD-531')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('Document not found: IPD-531')).toBeInTheDocument();
  });

  test('an integration call reads as its action and the system it ran against, not its id', () => {
    const activity = buildToolActivity(
      runFrom([
        started,
        call(2, 'tool/started', 'c1', 'muc-ad__search_people', {
          title: 'Search people',
          integration: 'Munich AD',
          args: { query: 'Daniel Manzke' },
          execution: 'server'
        }),
        call(3, 'tool/completed', 'c1', 'muc-ad__search_people', { durationMs: 40 }),
        call(4, 'tool/started', 'c2', 'legacy_tool', { args: {}, execution: 'server' }),
        call(5, 'tool/completed', 'c2', 'legacy_tool', { durationMs: 10 }),
        ended(6)
      ])
    );
    expect(activity.items[0]).toMatchObject({
      name: 'Search people',
      titled: true,
      integration: 'Munich AD'
    });
    render(<ToolActivity activity={activity} loading={false} />);
    // The summary names the system the answer came from.
    expect(screen.getByRole('button')).toHaveTextContent('Munich AD');
    fireEvent.click(screen.getByRole('button'));
    const action = screen.getByText('Search people');
    expect(action).toHaveAttribute('title', 'muc-ad__search_people');
    expect(screen.getByTitle('Data from Munich AD')).toHaveTextContent('Munich AD');
    expect(screen.queryByText('muc-ad__search_people')).not.toBeInTheDocument();
    // A tool without a title still reads by its name.
    expect(screen.getByText('Ran legacy_tool')).toBeInTheDocument();
  });

  test('a connected system search is a plain call, not a web search', () => {
    const activity = buildToolActivity(
      runFrom([
        started,
        call(2, 'tool/started', 'c1', 'jira_searchTickets', {
          title: 'Search tickets',
          integration: 'Jira',
          activityKind: 'tool',
          args: { query: 'login bug' },
          execution: 'server'
        }),
        call(3, 'tool/completed', 'c1', 'jira_searchTickets', { durationMs: 40 }),
        ended(4)
      ])
    );
    expect(activity.items[0]).toMatchObject({ kind: 'tool', scope: null, query: null });
    render(<ToolActivity activity={activity} loading={false} />);
    const toggle = screen.getByRole('button');
    expect(toggle).not.toHaveTextContent('Searched the web');
    expect(screen.getAllByTestId('icon').map(icon => icon.dataset.name)).toContain('wrench');
    expect(screen.getAllByTestId('icon').map(icon => icon.dataset.name)).not.toContain('globe-alt');
    fireEvent.click(toggle);
    expect(screen.getByText('Search tickets')).toBeInTheDocument();
    // The query is an argument of the call, listed like any other.
    expect(screen.getByText('login bug')).toBeInTheDocument();
  });

  test('renders nothing without activity', () => {
    const { container } = render(<ToolActivity activity={{ items: [], reading: null }} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('page reader rows (issue #2520)', () => {
  const readStarted = (seq, callId, url) =>
    env(seq, 'tool/started', {
      step: 1,
      callId,
      toolId: 'read_url',
      name: 'read_url',
      args: { url },
      execution: 'server'
    });

  test('show the title, the site, the words read and a truncated hint', () => {
    const run = runFrom([
      started,
      readStarted(2, 'r1', 'https://docs.example.com/guide'),
      env(3, 'tool/completed', {
        step: 1,
        callId: 'r1',
        toolId: 'read_url',
        name: 'read_url',
        resultPreview: '…'
      }),
      env(4, 'sources/added', {
        step: 1,
        callId: 'r1',
        toolId: 'read_url',
        items: [
          {
            id: 'url:docs.example.com/guide',
            provider: 'web',
            kind: 'page',
            url: 'https://docs.example.com/guide',
            title: 'The guide',
            read: { ok: true, words: 812, truncated: true },
            private: true
          }
        ]
      }),
      ended(5)
    ]);
    render(<ToolActivity activity={buildToolActivity(run)} loading />);
    expect(screen.getByText('The guide')).toBeInTheDocument();
    expect(screen.getByText('docs.example.com')).toBeInTheDocument();
    expect(screen.getByText('toolActivity.wordsRead:812')).toBeInTheDocument();
    expect(screen.getByText('truncated')).toBeInTheDocument();
  });

  test('say when the per-turn page read cap refused a read', () => {
    const run = runFrom([
      started,
      readStarted(2, 'r1', 'https://docs.example.com/more'),
      env(3, 'tool/completed', {
        step: 1,
        callId: 'r1',
        toolId: 'read_url',
        name: 'read_url',
        resultPreview: { limitReached: true, code: 'PAGE_READ_LIMIT_REACHED', maxPageReads: 5 }
      }),
      ended(4)
    ]);
    const activity = buildToolActivity(run);
    expect(activity.items[0].limitReached).toBe(true);
    render(<ToolActivity activity={activity} loading />);
    expect(screen.getByText('Not read')).toBeInTheDocument();
    expect(screen.getByText(/Page read limit reached for this answer/)).toBeInTheDocument();
  });
});

describe('skill rows — each activation once in the chain, each skill once in the header', () => {
  const activate = (seq, data) =>
    env(seq, 'tool/progress', { phase: 'skill.activation', message: data.skillName, data });
  const loadSkill = (seq, callId) =>
    env(seq, 'tool/started', {
      step: 1,
      callId,
      toolId: 'activate_skill',
      name: 'activate_skill',
      args: { skill_name: 'research' },
      execution: 'server'
    });
  const research = { skillName: 'Research', skillId: 'research', description: 'Deep research' };

  // The user starts the skill with /research, the model then loads it in two
  // later rounds, with a search in between.
  const activatedThrice = () =>
    runFrom([
      started,
      activate(2, { ...research, activatedBy: 'user' }),
      loadSkill(3, 'a1'),
      activate(4, { ...research, activatedBy: 'model' }),
      searchStarted(5),
      searchCompleted(6),
      loadSkill(7, 'a2'),
      activate(8, { ...research, activatedBy: 'model' }),
      ended(9)
    ]);

  test('run.skills holds the skill once, however often it was activated', () => {
    expect(activatedThrice().skills).toEqual([
      { name: 'Research', description: 'Deep research', id: 'research', activatedBy: 'user' }
    ]);
    expect(projectRunToMessage(activatedThrice()).extras.activeSkills).toHaveLength(1);
  });

  test('the user activation wins over a later model one, whichever comes first', () => {
    const run = runFrom([
      started,
      activate(2, { ...research, activatedBy: 'model' }),
      activate(3, { ...research, activatedBy: 'user' })
    ]);
    expect(run.skills).toHaveLength(1);
    expect(run.skills[0].activatedBy).toBe('user');
  });

  test('skills with different ids stay apart, even under one display name', () => {
    const run = runFrom([
      started,
      activate(2, { skillName: 'Notes', skillId: 'global-notes', description: '' }),
      activate(3, { skillName: 'Notes', skillId: 'user-notes', description: '' })
    ]);
    expect(run.skills.map(skill => skill.id)).toEqual(['global-notes', 'user-notes']);
  });

  test('every activation is a row of the chain, in time order, saying who activated it', () => {
    const { items } = buildToolActivity(activatedThrice());
    expect(items.map(item => [item.kind, item.activatedBy ?? item.toolId])).toEqual([
      ['skill', 'user'],
      ['skill', 'model'],
      ['search', 'braveSearch'],
      ['skill', 'model']
    ]);
    expect(items[0]).toMatchObject({ name: 'Research', skillId: 'research', status: 'completed' });
    // The activate_skill calls themselves add no rows.
    expect(items.some(item => item.id === 'a1' || item.id === 'a2')).toBe(false);
    expect(new Set(items.map(item => item.id)).size).toBe(items.length);
  });

  test('a turn that only used a skill still has a chain', () => {
    const run = runFrom([started, activate(2, { ...research, activatedBy: 'user' }), ended(3)]);
    expect(buildToolActivity(run).items).toHaveLength(1);
  });

  test('a refused activate_skill call (no activation frame) leaves no row', () => {
    expect(buildToolActivity(runFrom([started, loadSkill(2, 'a1'), ended(3)]))).toBeNull();
  });

  test('the component lists each activation and counts the skill once', () => {
    render(<ToolActivity activity={buildToolActivity(activatedThrice())} loading={false} />);
    const toggle = screen.getByRole('button');
    expect(toggle).toHaveTextContent('toolActivity.skills:1');
    fireEvent.click(toggle);
    expect(screen.getAllByText('Used skill')).toHaveLength(3);
    expect(screen.getAllByText('Research')).toHaveLength(3);
    expect(screen.getByText('started by you')).toBeInTheDocument();
    expect(screen.getAllByText('loaded by the model')).toHaveLength(2);
  });

  test('a chain of skills alone gets the skill icon, not a globe', () => {
    const run = runFrom([started, activate(2, { ...research, activatedBy: 'user' }), ended(3)]);
    render(<ToolActivity activity={buildToolActivity(run)} loading={false} />);
    expect(screen.getAllByTestId('icon')[0]).toHaveAttribute('data-name', 'sparkles');
  });
});

// ── tool calls whose arguments are still streaming (#3534) ────────────────

/** A `tool/progress` frame as the server sends it: frame fields beside `phase`, payload under `data`. */
const progress = (seq, phase, frame, data, extra = {}) => ({
  ...env(seq, 'tool/progress', { phase, step: 1, ...frame, data }),
  ...extra
});
const ARTIFACT = 'create_web_artifact';
const artifactArgs = (seq, callId, data = {}, extra = {}) =>
  progress(
    seq,
    'args',
    { callId, toolId: ARTIFACT },
    {
      name: ARTIFACT,
      title: 'Create web artifact',
      outputKind: 'webArtifact',
      argBytes: 12288,
      elapsedMs: 41000,
      ...data
    },
    extra
  );
const artifactEnded = (seq, callId, outcome, data = {}, extra = {}) =>
  progress(
    seq,
    'args.ended',
    { callId, toolId: ARTIFACT },
    { outcome, argBytes: 33000, elapsedMs: 63000, ...data },
    extra
  );
const artifactStarted = (seq, callId) =>
  env(seq, 'tool/started', {
    step: 1,
    callId,
    toolId: ARTIFACT,
    name: ARTIFACT,
    title: 'Create web artifact',
    args: { filename: 'a.html' },
    execution: 'server'
  });
const artifactCompleted = (seq, callId, data = {}) =>
  env(seq, 'tool/completed', { step: 1, callId, toolId: ARTIFACT, name: ARTIFACT, ...data });
const waitingFrame = (seq, data) => progress(seq, 'model.waiting', {}, data);

describe('buildToolActivity — a call that is still being written', () => {
  const rowOf = (frames, index = 0) =>
    buildToolActivity(runFrom([started, ...frames])).items[index];

  test('is a preparing row with what the server said it is', () => {
    expect(rowOf([artifactArgs(2, 'x1')])).toMatchObject({
      id: 'x1',
      kind: 'tool',
      toolId: ARTIFACT,
      name: 'Create web artifact',
      titled: true,
      status: 'preparing',
      started: false,
      outputKind: 'webArtifact',
      argBytes: 12288,
      elapsedMs: 41000,
      ready: false,
      errorCode: null,
      occurrence: null
    });
  });

  test('the kind is the server’s activityKind, never inferred from the tool id', () => {
    const search = progress(
      2,
      'args',
      { callId: 'x1', toolId: 'braveSearch' },
      { name: 'braveSearch', activityKind: 'search', argBytes: 10, elapsedMs: 1500 }
    );
    expect(rowOf([search])).toMatchObject({ kind: 'search', status: 'preparing' });
    const plain = progress(
      2,
      'args',
      { callId: 'x1', toolId: 'braveSearch' },
      { name: 'braveSearch', argBytes: 10, elapsedMs: 1500 }
    );
    expect(rowOf([plain])).toMatchObject({ kind: 'tool', outputKind: null });
  });

  test('keeps one row, in the same place, from preparing to running to completed', () => {
    const before = [searchStarted(2, 'c1'), searchCompleted(3, 'c1')];
    const frames = [
      ...before,
      artifactArgs(4, 'x1'),
      // Another call starts and finishes while the file is still being written.
      env(5, 'tool/started', {
        step: 1,
        callId: 'c2',
        toolId: 'jira',
        name: 'jira',
        args: {},
        execution: 'server'
      }),
      env(6, 'tool/completed', { step: 1, callId: 'c2', toolId: 'jira', name: 'jira' })
    ];
    const order = fs => buildToolActivity(runFrom([started, ...fs])).items.map(item => item.id);
    // The call that announced itself first is listed first, before the later one.
    expect(order(frames)).toEqual(['c1', 'x1', 'c2']);
    const afterwards = [
      ...frames,
      artifactEnded(7, 'x1', 'ready'),
      artifactStarted(8, 'x1'),
      artifactCompleted(9, 'x1', { files: [] })
    ];
    expect(order(afterwards)).toEqual(['c1', 'x1', 'c2']);
    const [, row] = buildToolActivity(runFrom([started, ...afterwards])).items;
    expect(row).toMatchObject({
      id: 'x1',
      status: 'completed',
      started: true,
      outputKind: 'webArtifact',
      // The size the model wrote stays on the row.
      argBytes: 33000
    });
    // The statuses on the way.
    const statusAfter = fs => buildToolActivity(runFrom([started, ...fs])).items[1].status;
    expect(statusAfter(frames)).toBe('preparing');
    expect(statusAfter([...frames, artifactEnded(7, 'x1', 'ready')])).toBe('preparing');
    expect(
      statusAfter([...frames, artifactEnded(7, 'x1', 'ready'), artifactStarted(8, 'x1')])
    ).toBe('running');
  });

  test('a call that ended ready but has not started is ready, not still being written', () => {
    expect(rowOf([artifactArgs(2, 'x1'), artifactEnded(3, 'x1', 'ready')])).toMatchObject({
      status: 'preparing',
      ready: true,
      argsComplete: true
    });
  });

  test('a ready call with an approval pending for it is awaiting', () => {
    const approval = (status = 'pending') =>
      env(4, 'interaction/raised', {
        interaction: {
          id: 'approve-1',
          kind: 'approval',
          origin: 'tool',
          status,
          source: { toolCallId: 'x1', toolId: ARTIFACT, chatId: 'chat-1' }
        }
      });
    const run = frames => buildToolActivity(runFrom([started, ...frames])).items[0];
    const written = [artifactArgs(2, 'x1'), artifactEnded(3, 'x1', 'ready')];
    expect(run([...written, approval()]).status).toBe('awaiting');
    // An approval for another call, or one already answered, does not make it wait.
    expect(run([...written, approval('answered')]).status).toBe('preparing');
    const other = env(4, 'interaction/raised', {
      interaction: {
        id: 'approve-2',
        kind: 'approval',
        origin: 'tool',
        status: 'pending',
        source: { toolCallId: 'other' }
      }
    });
    expect(run([...written, other]).status).toBe('preparing');
  });

  test.each([
    ['dropped', 'dropped'],
    ['invalid', 'invalid'],
    ['truncated', 'truncated']
  ])('a call that ended %s is a failed row with that reason', (outcome, errorCode) => {
    expect(rowOf([artifactArgs(2, 'x1'), artifactEnded(3, 'x1', outcome)])).toMatchObject({
      status: 'error',
      errorCode,
      error: null
    });
  });

  test('a call aborted while it was written is stopped', () => {
    expect(rowOf([artifactArgs(2, 'x1'), artifactEnded(3, 'x1', 'aborted')]).status).toBe(
      'stopped'
    );
  });

  test('a call still being written when the turn ends reads as stopped, never as preparing', () => {
    const over = env(5, 'run/ended', { status: 'aborted', finishReason: 'connection_closed' });
    // Never closed: the stream ended without a closing frame.
    expect(rowOf([artifactArgs(2, 'x1'), over])).toMatchObject({
      status: 'stopped',
      argsComplete: false,
      ready: false
    });
    // Ready but never started: stopped as well, and it knows it was written.
    expect(rowOf([artifactArgs(2, 'x1'), artifactEnded(3, 'x1', 'ready'), over])).toMatchObject({
      status: 'stopped',
      argsComplete: true
    });
  });

  test('a repeat of the same tool carries its number', () => {
    const [first, second] = buildToolActivity(
      runFrom([
        started,
        artifactArgs(2, 'x1'),
        artifactEnded(3, 'x1', 'ready'),
        artifactStarted(4, 'x1'),
        artifactCompleted(5, 'x1'),
        artifactArgs(6, 'x2', { occurrence: 2, argBytes: 100, elapsedMs: 10 })
      ])
    ).items;
    expect(first.occurrence).toBeNull();
    expect(second).toMatchObject({ id: 'x2', occurrence: 2, status: 'preparing' });
  });

  test('keeps hiding the calls that have their own UI, announced or not', () => {
    const announced = (callId, toolId) =>
      progress(2, 'args', { callId, toolId }, { name: toolId, argBytes: 10, elapsedMs: 1500 });
    expect(buildToolActivity(runFrom([started, announced('s', 'activate_skill')]))).toBeNull();
    expect(buildToolActivity(runFrom([started, announced('q', 'ask_user')]))).toBeNull();
    // A call the server runs elsewhere is not a row either, once it started.
    const passthrough = env(4, 'tool/started', {
      step: 1,
      callId: 'w',
      toolId: 'workflow_x',
      name: 'workflow_x',
      args: {},
      execution: 'passthrough'
    });
    expect(
      buildToolActivity(runFrom([started, announced('w', 'workflow_x'), passthrough]))
    ).toBeNull();
  });
});

describe('buildToolActivity — the turn is silent or answering', () => {
  const activityOf = frames => buildToolActivity(runFrom([started, ...frames]));

  test('a silent model call is the idle line, said the way the server said it', () => {
    expect(activityOf([waitingFrame(2, { elapsedMs: 3000 })])).toMatchObject({
      items: [],
      idle: { kind: 'waiting', elapsedMs: 3000 }
    });
    expect(activityOf([waitingFrame(2, { elapsedMs: 7000, reasoning: true })]).idle).toMatchObject({
      kind: 'thinking',
      elapsedMs: 7000
    });
  });

  test('rows and the idle line go together', () => {
    const activity = activityOf([
      searchStarted(2),
      searchCompleted(3),
      waitingFrame(4, { elapsedMs: 3000 })
    ]);
    expect(activity.items).toHaveLength(1);
    expect(activity.idle.kind).toBe('waiting');
  });

  test('visible output ends it', () => {
    expect(
      activityOf([
        waitingFrame(2, { elapsedMs: 3000 }),
        env(3, 'step/delta', { step: 1, kind: 'text', content: 'Hi' })
      ])
    ).toBeNull();
  });

  test('a finished or paused turn has no idle line', () => {
    expect(activityOf([waitingFrame(2, { elapsedMs: 3000 }), ended(3)])).toBeNull();
    expect(activityOf([waitingFrame(2, { elapsedMs: 3000 }), env(3, 'run/paused', {})])).toBeNull();
  });

  test('answer text is flagged on a turn that has rows, while it is still going', () => {
    const text = env(4, 'step/delta', { step: 1, kind: 'text', content: 'Hi' });
    expect(activityOf([searchStarted(2), searchCompleted(3), text]).answering).toBe(true);
    expect(activityOf([searchStarted(2), searchCompleted(3)]).answering).toBeUndefined();
    expect(activityOf([searchStarted(2), searchCompleted(3), text, ended(5)]).answering).toBe(
      undefined
    );
  });

  test('is never stored with the answer', () => {
    const idleOnly = runFrom([started, waitingFrame(2, { elapsedMs: 3000 })]);
    expect(buildRunActivity(idleOnly)).toBeNull();
    const withRows = runFrom([
      started,
      searchStarted(2),
      searchCompleted(3),
      waitingFrame(4, { elapsedMs: 3000 })
    ]);
    expect(buildRunActivity(withRows).toolActivity).toEqual({
      items: expect.any(Array),
      reading: null
    });
  });

  test('the message loses the idle line when it ends, even when no row ever came', () => {
    const idleRun = runFrom([started, waitingFrame(2, { elapsedMs: 3000 })]);
    expect(projectRunToMessage(idleRun).extras.toolActivity.idle.kind).toBe('waiting');
    const answering = runFrom([
      started,
      waitingFrame(2, { elapsedMs: 3000 }),
      env(3, 'step/delta', { step: 1, kind: 'text', content: 'Hi' })
    ]);
    const { extras } = projectRunToMessage(answering);
    // The key is there and empty: a message keeps what a projection leaves out.
    expect(Object.keys(extras)).toContain('toolActivity');
    expect(extras.toolActivity).toBeUndefined();
  });
});

describe('the headline of the activity', () => {
  const activityOf = frames => buildToolActivity(runFrom([started, ...frames]));
  const modeOf = (frames, loading = true) => headlineModeOf(activityOf(frames), loading).mode;
  const written = [artifactArgs(2, 'x1'), artifactEnded(3, 'x1', 'ready')];

  test('names the first thing that matches', () => {
    // Waiting for approval beats everything, even a turn that is no longer loading.
    const approval = env(4, 'interaction/raised', {
      interaction: {
        id: 'a1',
        kind: 'approval',
        origin: 'tool',
        status: 'pending',
        source: { toolCallId: 'x1' }
      }
    });
    expect(modeOf([...written, approval], false)).toBe('awaiting');
    expect(modeOf([artifactArgs(2, 'x1')])).toBe('preparing');
    expect(modeOf([searchStarted(2)])).toBe('running');
    expect(
      modeOf([searchStarted(2), searchCompleted(3), waitingFrame(4, { elapsedMs: 3000 })])
    ).toBe('idle');
    expect(modeOf([searchStarted(2), searchCompleted(3)])).toBe('between');
    expect(
      modeOf([
        searchStarted(2),
        searchCompleted(3),
        env(4, 'step/delta', { step: 1, kind: 'text', content: 'Hi' })
      ])
    ).toBe('summary');
    expect(modeOf([searchStarted(2), searchCompleted(3), ended(4)], false)).toBe('summary');
  });

  test('a call whose arguments are complete does not own the line while another is written', () => {
    const frames = [
      artifactArgs(2, 'x1'),
      artifactEnded(3, 'x1', 'ready'),
      artifactArgs(4, 'x2', { argBytes: 100, elapsedMs: 10 })
    ];
    const headline = headlineModeOf(activityOf(frames), true);
    expect(headline.owner.id).toBe('x2');
    expect(headline.more).toBe(1);
  });

  test('the three-dot loader stands down while the headline shows a spinner or label', () => {
    expect(isActivityLineBusy(activityOf([artifactArgs(2, 'x1')]), true)).toBe(true);
    expect(isActivityLineBusy(activityOf([waitingFrame(2, { elapsedMs: 3000 })]), true)).toBe(true);
    expect(isActivityLineBusy(activityOf([searchStarted(2), searchCompleted(3)]), true)).toBe(true);
    // Not while the answer streams, not once it is over, not without activity.
    const answering = [
      searchStarted(2),
      searchCompleted(3),
      env(4, 'step/delta', { step: 1, kind: 'text', content: 'Hi' })
    ];
    expect(isActivityLineBusy(activityOf(answering), true)).toBe(false);
    expect(isActivityLineBusy(activityOf([artifactArgs(2, 'x1')]), false)).toBe(false);
    expect(isActivityLineBusy(null, true)).toBe(false);
  });
});

describe('ArgumentProgress helpers', () => {
  test('formatSize: nothing below 1 KB, whole KB, then MB in the reader’s format', () => {
    expect(formatSize(1023, 'en')).toBe('');
    expect(formatSize(0, 'en')).toBe('');
    expect(formatSize(undefined, 'en')).toBe('');
    expect(formatSize(1024, 'en')).toBe('1 KB');
    expect(formatSize(12288, 'en')).toBe('12 KB');
    expect(formatSize(12288, 'de')).toBe('12 KB');
    // Rounds to 1024 KB, which reads as 1.0 MB, not "1024 KB".
    expect(formatSize(1048575, 'en')).toBe('1.0 MB');
    expect(formatSize(1048576, 'en')).toBe('1.0 MB');
    expect(formatSize(1.4 * 1048576, 'en')).toBe('1.4 MB');
    expect(formatSize(1.4 * 1048576, 'de')).toBe('1,4 MB');
    // A language the runtime does not know falls back instead of throwing.
    expect(formatSize(12288, 'not a language')).toBe('12 KB');
  });

  test('formatClock: m:ss, h:mm:ss from one hour', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(999)).toBe('0:00');
    expect(formatClock(7000)).toBe('0:07');
    expect(formatClock(59000)).toBe('0:59');
    expect(formatClock(60000)).toBe('1:00');
    expect(formatClock(725000)).toBe('12:05');
    expect(formatClock(3599000)).toBe('59:59');
    expect(formatClock(3600000)).toBe('1:00:00');
    expect(formatClock(-5)).toBe('0:00');
  });

  test('the stopwatch is the newest frame’s reading plus the time since it arrived', () => {
    const anchor = { elapsedMs: 41000, receivedAt: 1000 };
    expect(elapsedAt(anchor, 1000)).toBe(41000);
    expect(elapsedAt(anchor, 6000)).toBe(46000);
    // A new frame is a new anchor: a reconnect corrects the clock.
    expect(elapsedAt({ elapsedMs: 50000, receivedAt: 6500 }, 7000)).toBe(50500);
    // Never negative, never ahead of an anchor from the future, frozen when not running.
    expect(elapsedAt(anchor, 500)).toBe(41000);
    expect(elapsedAt(anchor, 99000, false)).toBe(41000);
  });

  test('a call is stalled once its size has not grown for 20 s', () => {
    const row = {
      status: 'preparing',
      ready: false,
      elapsedMs: 30000,
      receivedAt: 0,
      grewAtMs: 10000
    };
    expect(isStalled(row, 0)).toBe(true);
    expect(isStalled({ ...row, grewAtMs: 10001 }, 0)).toBe(false);
    // The clock keeps running between frames.
    expect(isStalled({ ...row, grewAtMs: 15000 }, 5000)).toBe(true);
    // Only a call that is being written can stall.
    expect(isStalled({ ...row, ready: true }, 0)).toBe(false);
    expect(isStalled({ ...row, status: 'running' }, 0)).toBe(false);
    expect(isStalled({ status: 'preparing' }, 0)).toBe(false);
  });

  test('a call is painted after the grace, and a refused one never unless it outlived it', () => {
    const preparing = { status: 'preparing', firstReceivedAt: 1000 };
    expect(isPainted(preparing, 1499)).toBe(false);
    expect(isPainted(preparing, 1500)).toBe(true);
    expect(paintsIn(preparing, 1100)).toBe(400);
    expect(paintsIn(preparing, 1500)).toBeNull();
    // A row that did not announce itself, or that moved on, shows at once.
    expect(isPainted({ status: 'running' }, 0)).toBe(true);
    expect(isPainted({ status: 'running', firstReceivedAt: 1000 }, 1001)).toBe(true);
    expect(isPainted({ status: 'completed', firstReceivedAt: 1000 }, 1001)).toBe(true);
    const dropped = { status: 'error', errorCode: 'dropped', firstReceivedAt: 1000 };
    expect(isPainted({ ...dropped, endedReceivedAt: 1400 }, 9000)).toBe(false);
    expect(isPainted({ ...dropped, endedReceivedAt: 1600 }, 9000)).toBe(true);
    expect(isPainted({ ...dropped, errorCode: 'truncated', endedReceivedAt: 1100 }, 9000)).toBe(
      true
    );
  });
});

describe('ToolActivity — a call that is being written', () => {
  const T0 = 100000;
  const frameAt = { receivedAt: T0 };
  const activityOf = frames => buildToolActivity(runFrom([started, ...frames]));
  const preparing = (data, callId = 'x1', seq = 2) => artifactArgs(seq, callId, data, frameAt);

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    // The reducer stamps frames with the monotonic clock; the tests set it by hand.
    jest.advanceTimersByTime(T0);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('says what is being made, with the size and clock beside it, and ticks', () => {
    render(<ToolActivity activity={activityOf([preparing()])} loading />);
    const toggle = screen.getByRole('button');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveTextContent('Creating web artifact… · 12 KB written · 0:41');
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(toggle).toHaveTextContent('Creating web artifact… · 12 KB written · 0:46');
  });

  test('keeps the numbers out of the accessible name and out of the reading order', () => {
    render(<ToolActivity activity={activityOf([preparing()])} loading />);
    // The name of the toggle does not change every second while it has focus.
    expect(screen.getByRole('button', { name: 'Creating web artifact…' })).toBeInTheDocument();
    for (const numbers of screen.getAllByText(/12 KB written/)) {
      expect(numbers.closest('[aria-hidden="true"]')).not.toBeNull();
    }
  });

  test('is silent for a screen reader: the list is a live region switched off and says it is busy', () => {
    const { container } = render(<ToolActivity activity={activityOf([preparing()])} loading />);
    expect(container.firstChild).toHaveAttribute('aria-live', 'off');
    expect(container.querySelector('ol')).toHaveAttribute('aria-busy', 'true');
    // There is no progress bar: the total is unknown.
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  test('the toggle has a 24 px target and a visible focus ring', () => {
    render(<ToolActivity activity={activityOf([preparing()])} loading />);
    const toggle = screen.getByRole('button');
    expect(toggle.className).toMatch(/\bpy-1\b/);
    expect(toggle.className).toMatch(/-my-1/);
    expect(toggle.className).toMatch(/focus-visible:ring-2/);
  });

  test('the row has its own progress line, and no size below 1 KB', () => {
    render(<ToolActivity activity={activityOf([preparing()])} loading />);
    const row = screen.getAllByRole('listitem')[0];
    expect(within(row).getByText('Creating web artifact')).toBeInTheDocument();
    expect(within(row).getByText('12 KB written · 0:41')).toBeInTheDocument();
  });

  test('shows only the clock until a KB has been written', () => {
    render(
      <ToolActivity
        activity={activityOf([preparing({ argBytes: 400, elapsedMs: 2000 })])}
        loading
      />
    );
    expect(screen.getByRole('button')).toHaveTextContent('Creating web artifact… · 0:02');
    expect(screen.getByRole('button')).not.toHaveTextContent('written');
  });

  test('a repeat is a second row with a neutral "No. 2" chip, the first one stays clean', () => {
    const frames = [
      artifactArgs(2, 'x1', {}, frameAt),
      artifactEnded(3, 'x1', 'ready', {}, frameAt),
      artifactStarted(4, 'x1'),
      artifactCompleted(5, 'x1'),
      artifactArgs(6, 'x2', { occurrence: 2, argBytes: 100, elapsedMs: 10 }, frameAt)
    ];
    render(<ToolActivity activity={activityOf(frames)} loading />);
    const [first, second] = screen.getAllByRole('listitem');
    expect(within(first).getByText('Created web artifact')).toBeInTheDocument();
    expect(within(first).queryByText(/No\./)).not.toBeInTheDocument();
    expect(within(second).getByText('Creating web artifact')).toBeInTheDocument();
    expect(within(second).getByText('No. 2')).toBeInTheDocument();
    // The headline speaks for the call being written.
    expect(screen.getByRole('button')).toHaveTextContent('Creating web artifact…');
  });

  test('a running file call reads like the preparing one, without the numbers', () => {
    const frames = [
      preparing(),
      artifactEnded(3, 'x1', 'ready', {}, frameAt),
      artifactStarted(4, 'x1')
    ];
    render(<ToolActivity activity={activityOf(frames)} loading />);
    expect(screen.getByRole('button')).toHaveTextContent(/^Creating web artifact…$/);
    expect(screen.queryByText(/written/)).not.toBeInTheDocument();
  });

  test('a tool without a file kind is "Preparing …" with its title', () => {
    const frame = progress(
      2,
      'args',
      { callId: 'm1', toolId: 'muc-ad__search_people' },
      {
        name: 'muc-ad__search_people',
        title: 'Search people',
        integration: 'Munich AD',
        argBytes: 3000,
        elapsedMs: 1600
      },
      frameAt
    );
    render(<ToolActivity activity={activityOf([frame])} loading />);
    expect(screen.getByRole('button')).toHaveTextContent(
      'Preparing Search people… · 3 KB written · 0:01'
    );
    const row = screen.getByRole('listitem');
    expect(within(row).getByText('Preparing Search people')).toBeInTheDocument();
    expect(within(row).getByTitle('Data from Munich AD')).toBeInTheDocument();
  });

  test('a search being written has no query yet and reads as a plain call', () => {
    const frame = progress(
      2,
      'args',
      { callId: 's1', toolId: 'braveSearch' },
      { name: 'braveSearch', activityKind: 'search', argBytes: 2000, elapsedMs: 1600 },
      frameAt
    );
    render(<ToolActivity activity={activityOf([frame])} loading />);
    expect(screen.getByText('Preparing braveSearch')).toBeInTheDocument();
    expect(screen.queryByText(/Ran braveSearch/)).not.toBeInTheDocument();
  });

  test('+N more counts the other calls that are busy, and is hidden from a screen reader', () => {
    const frames = [
      preparing({ argBytes: 8192, elapsedMs: 20000 }, 'x1', 2),
      preparing({ argBytes: 100, elapsedMs: 100 }, 'x2', 3)
    ];
    render(<ToolActivity activity={activityOf(frames)} loading />);
    const more = screen.getByText(/toolActivity\.alsoActive:1/);
    expect(more.closest('[aria-hidden="true"]')).not.toBeNull();
    // On a phone it gives way to the label.
    expect(more.className).toMatch(/max-sm:hidden/);
  });

  test('a call that is complete but waiting for a parallel one says it is ready, and stands still', () => {
    const frames = [
      preparing(),
      artifactEnded(3, 'x1', 'ready', { argBytes: 20480 }, frameAt),
      preparing({ argBytes: 100, elapsedMs: 100 }, 'x2', 4)
    ];
    render(<ToolActivity activity={activityOf(frames)} loading />);
    const [row] = screen.getAllByRole('listitem');
    expect(within(row).getByText('20 KB written · ready to run')).toBeInTheDocument();
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(within(row).getByText('20 KB written · ready to run')).toBeInTheDocument();
  });

  test('says so when the size has not grown for a while, and stops saying so when it grows', () => {
    const stalled = activityOf([preparing({ argBytes: 8192, elapsedMs: 52000 })]);
    // 8 KB written at 0:10, nothing since (the clock reads 0:52).
    stalled.items[0].grewAtMs = 10000;
    const { rerender } = render(<ToolActivity activity={stalled} loading />);
    const caption = 'No new output for a while. The model may be busy — you can wait or stop.';
    expect(screen.getByText(caption)).toBeInTheDocument();
    const grown = activityOf([preparing({ argBytes: 9000, elapsedMs: 53000 })]);
    grown.items[0].grewAtMs = 53000;
    rerender(<ToolActivity activity={grown} loading />);
    expect(screen.queryByText(caption)).not.toBeInTheDocument();
  });

  test('shows the caption as soon as the clock passes the stall limit, without a new frame', () => {
    const activity = activityOf([preparing({ argBytes: 8192, elapsedMs: 10000 })]);
    activity.items[0].grewAtMs = 10000;
    render(<ToolActivity activity={activity} loading />);
    expect(screen.queryByText(/No new output/)).not.toBeInTheDocument();
    act(() => {
      jest.advanceTimersByTime(21000);
    });
    expect(screen.getByText(/No new output/)).toBeInTheDocument();
  });

  test.each([
    ['truncated', 'Incomplete — the model reached its output limit before the call was finished.'],
    ['invalid', 'Incomplete — the call data from the model could not be read.'],
    ['dropped', 'Not created — the model’s request could not be used.']
  ])('a call that ended %s says why, in red, with the last size', (outcome, sentence) => {
    const frames = [
      preparing(),
      artifactEnded(3, 'x1', outcome, { argBytes: 20480, elapsedMs: 72000 }, frameAt)
    ];
    render(<ToolActivity activity={activityOf(frames)} loading={false} />);
    fireEvent.click(screen.getByRole('button'));
    const row = screen.getByRole('listitem');
    expect(within(row).getByText('Failed')).toBeInTheDocument();
    expect(within(row).getByText(sentence).className).toMatch(/text-red-600/);
    expect(within(row).getByText('20 KB written · 1:12')).toBeInTheDocument();
    expect(within(row).getAllByTestId('icon')[0]).toHaveAttribute(
      'data-name',
      'exclamation-circle'
    );
  });

  test('a call stopped while it was written is quiet gray, with a sentence and no "Stopped" word', () => {
    const frames = [preparing(), env(5, 'run/ended', { status: 'aborted' })];
    render(<ToolActivity activity={activityOf(frames)} loading={false} />);
    // The summary does not read like success.
    expect(screen.getByRole('button')).toHaveTextContent(/^Stopped$/);
    fireEvent.click(screen.getByRole('button'));
    const row = screen.getByRole('listitem');
    const sentence = within(row).getByText('Stopped — the unfinished call was not run.');
    expect(sentence.className).toMatch(/text-gray-600/);
    expect(sentence.className).not.toMatch(/red/);
    expect(within(row).queryByText(/^Stopped$/)).not.toBeInTheDocument();
    // Frozen at the last reading: nothing ticks any more.
    expect(within(row).getByText('12 KB written · 0:41')).toBeInTheDocument();
  });

  test('a call written completely but never run says it was not run', () => {
    const frames = [
      preparing(),
      artifactEnded(3, 'x1', 'ready', {}, frameAt),
      env(5, 'run/ended', { status: 'aborted' })
    ];
    render(<ToolActivity activity={activityOf(frames)} loading={false} />);
    fireEvent.click(screen.getByRole('button'));
    expect(within(screen.getByRole('listitem')).getByText('Not run')).toBeInTheDocument();
  });

  test('a stopped call that had started keeps the plain "Stopped" word', () => {
    const frames = [
      preparing(),
      artifactEnded(3, 'x1', 'ready', {}, frameAt),
      artifactStarted(4, 'x1'),
      env(5, 'run/ended', { status: 'aborted' })
    ];
    render(<ToolActivity activity={activityOf(frames)} loading={false} />);
    fireEvent.click(screen.getByRole('button'));
    expect(within(screen.getByRole('listitem')).getByText('Stopped')).toBeInTheDocument();
  });

  test('a finished file is named by what it made, not counted as a tool call', () => {
    const frames = [
      searchStarted(2),
      searchCompleted(3),
      preparing({}, 'x1', 4),
      artifactEnded(5, 'x1', 'ready', {}, frameAt),
      artifactStarted(6, 'x1'),
      artifactCompleted(7, 'x1'),
      ended(8)
    ];
    render(<ToolActivity activity={activityOf(frames)} loading={false} />);
    const toggle = screen.getByRole('button');
    expect(toggle).toHaveTextContent(
      'Searched the web · toolActivity.searches:1 · Created web artifact'
    );
    expect(toggle).not.toHaveTextContent('toolCalls');
    fireEvent.click(toggle);
    expect(screen.getByText('Created web artifact', { selector: 'li span' })).toBeInTheDocument();
    // The row wears the glyph of what it made.
    const rows = screen.getAllByRole('listitem');
    expect(
      within(rows[1])
        .getAllByTestId('icon')
        .map(icon => icon.dataset.name)
    ).toContain('code-bracket');
  });

  test('a file whose arguments could not be used shows in the summary as failed', () => {
    const frames = [preparing(), artifactEnded(3, 'x1', 'truncated', {}, frameAt), ended(4)];
    render(<ToolActivity activity={activityOf(frames)} loading={false} />);
    expect(screen.getByRole('button')).toHaveTextContent(/^Failed$/);
    expect(screen.getAllByTestId('icon')[0]).toHaveAttribute('data-name', 'exclamation-circle');
  });

  test('a call waiting for approval is not busy: a shield, no spinner, and the words', () => {
    const approval = env(4, 'interaction/raised', {
      interaction: {
        id: 'a1',
        kind: 'approval',
        origin: 'tool',
        status: 'pending',
        source: { toolCallId: 'x1' }
      }
    });
    const frames = [preparing(), artifactEnded(3, 'x1', 'ready', {}, frameAt), approval];
    const { container } = render(<ToolActivity activity={activityOf(frames)} loading={false} />);
    const toggle = screen.getByRole('button');
    expect(toggle).toHaveTextContent('Waiting for approval');
    expect(screen.getAllByTestId('icon')[0]).toHaveAttribute('data-name', 'shield-check');
    expect(container.querySelector('[data-name="spinner"]')).toBeNull();
    fireEvent.click(toggle);
    const row = screen.getByRole('listitem');
    expect(within(row).getByText('Creating web artifact')).toBeInTheDocument();
    expect(within(row).getByText('Waiting for approval')).toBeInTheDocument();
  });
});

describe('ToolActivity — the model is silent', () => {
  const T0 = 100000;
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    jest.advanceTimersByTime(T0);
  });
  afterEach(() => {
    jest.useRealTimers();
  });
  const idle = (kind, elapsedMs) => ({ kind, elapsedMs, receivedAt: T0, step: 1 });

  test('with no rows it is a line, not a button, with the clock', () => {
    const { container } = render(
      <ToolActivity activity={{ items: [], reading: null, idle: idle('waiting', 12000) }} loading />
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(container.firstChild).toHaveAttribute('aria-live', 'off');
    expect(container.firstChild).toHaveTextContent('Waiting for the model… · 0:12');
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    expect(container.firstChild).toHaveTextContent('Waiting for the model… · 0:15');
  });

  test('says "Thinking…" when the server says the model is reasoning, with a light bulb under reduced motion', () => {
    const { container } = render(
      <ToolActivity activity={{ items: [], reading: null, idle: idle('thinking', 7000) }} loading />
    );
    expect(container.firstChild).toHaveTextContent('Thinking… · 0:07');
    const icons = screen.getAllByTestId('icon').map(icon => icon.dataset.name);
    expect(icons).toEqual(['spinner', 'light-bulb']);
  });

  test('says how many outdated documents the turn is refreshing before it starts', () => {
    const { container } = render(
      <ToolActivity
        activity={{
          items: [],
          reading: null,
          idle: { kind: 'refreshing', total: 12, done: 5, elapsedMs: 0, receivedAt: T0, step: null }
        }}
        loading
      />
    );
    expect(container.firstChild).toHaveTextContent('Refreshing outdated documents… 5 of 12');
    const icons = screen.getAllByTestId('icon').map(icon => icon.dataset.name);
    expect(icons).toEqual(['spinner', 'arrow-path']);
  });

  test('the numbers are hidden from a screen reader', () => {
    render(
      <ToolActivity activity={{ items: [], reading: null, idle: idle('waiting', 12000) }} loading />
    );
    expect(screen.getByText('· 0:12').closest('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.getByText('Waiting for the model…')).not.toHaveAttribute('aria-hidden');
  });

  test('with rows it takes the headline of the list, which stays a button', () => {
    const activity = buildToolActivity(runFrom([started, searchStarted(2), searchCompleted(3)]));
    render(<ToolActivity activity={{ ...activity, idle: idle('waiting', 5000) }} loading />);
    expect(screen.getByRole('button')).toHaveTextContent('Waiting for the model… · 0:05');
  });

  test('between two calls the summary keeps a spinner: never a "done" icon while the turn goes on', () => {
    const activity = buildToolActivity(runFrom([started, searchStarted(2), searchCompleted(3)]));
    render(<ToolActivity activity={activity} loading />);
    expect(screen.getAllByTestId('icon')[0]).toHaveAttribute('data-name', 'spinner');
    expect(screen.getByRole('button')).toHaveTextContent('Searched the web');
    // Once the answer streams the spinner goes and the summary stays.
    cleanup();
    render(<ToolActivity activity={{ ...activity, answering: true }} loading />);
    expect(screen.getAllByTestId('icon')[0]).toHaveAttribute('data-name', 'globe-alt');
  });
});

describe('BusyIcon', () => {
  test('renders the spinner and, for reduced motion, a static twin; CSS picks one', () => {
    render(<BusyIcon staticIcon="light-bulb" />);
    const [spinner, twin] = screen.getAllByTestId('icon');
    expect(spinner).toHaveAttribute('data-name', 'spinner');
    expect(spinner.className).toMatch(/\banimate-spin\b/);
    expect(spinner.className).toMatch(/motion-reduce:hidden/);
    expect(twin).toHaveAttribute('data-name', 'light-bulb');
    expect(twin.className).toMatch(/\bhidden\b/);
    expect(twin.className).toMatch(/motion-reduce:inline-block/);
    // Both wear the active colour, light and dark.
    for (const icon of [spinner, twin]) {
      expect(icon.className).toMatch(/text-indigo-600/);
      expect(icon.className).toMatch(/dark:text-indigo-400/);
    }
  });

  test('the static twin is a clock by default', () => {
    render(<BusyIcon />);
    expect(screen.getAllByTestId('icon')[1]).toHaveAttribute('data-name', 'clock');
  });
});

describe('useGracedActivity — no row for a call that is written in half a second', () => {
  const T0 = 100000;
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    jest.advanceTimersByTime(T0);
  });
  afterEach(() => {
    jest.useRealTimers();
  });
  const activityOf = frames => buildToolActivity(runFrom([started, ...frames]));
  const at = receivedAt => ({ receivedAt });
  const first = artifactArgs(2, 'x1', { argBytes: 100, elapsedMs: 5 }, at(T0));

  test('holds the first paint back for the grace period, then shows the row', () => {
    const activity = activityOf([first]);
    const { result } = renderHook(() => useGracedActivity(activity));
    expect(result.current).toBeNull();
    act(() => {
      jest.advanceTimersByTime(499);
    });
    expect(result.current).toBeNull();
    act(() => {
      jest.advanceTimersByTime(2);
    });
    expect(result.current.items.map(item => item.id)).toEqual(['x1']);
    // Once shown it stays, whatever frames follow.
    const later = activityOf([first, artifactArgs(3, 'x1', { argBytes: 900 }, at(T0 + 600))]);
    const { result: again } = renderHook(() => useGracedActivity(later));
    act(() => {
      jest.advanceTimersByTime(600);
    });
    expect(again.current.items).toHaveLength(1);
  });

  test('a call that finishes writing inside the grace never shows a preparing row', () => {
    const preparing = activityOf([first]);
    const { result, rerender } = renderHook(({ activity }) => useGracedActivity(activity), {
      initialProps: { activity: preparing }
    });
    expect(result.current).toBeNull();
    act(() => {
      jest.advanceTimersByTime(200);
    });
    // Its tool starts: the row is a running row, shown at once, never "preparing".
    const running = activityOf([
      first,
      artifactEnded(3, 'x1', 'ready', {}, at(T0 + 200)),
      artifactStarted(4, 'x1')
    ]);
    rerender({ activity: running });
    expect(result.current.items.map(item => item.status)).toEqual(['running']);
  });

  test('a call refused inside the grace is never shown as failed; one that outlived it is', () => {
    const refusedEarly = activityOf([first, artifactEnded(3, 'x1', 'dropped', {}, at(T0 + 100))]);
    const { result } = renderHook(() => useGracedActivity(refusedEarly));
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(result.current).toBeNull();
    const refusedLate = activityOf([first, artifactEnded(3, 'x1', 'dropped', {}, at(T0 + 900))]);
    const { result: late } = renderHook(() => useGracedActivity(refusedLate));
    expect(late.current.items[0]).toMatchObject({ status: 'error', errorCode: 'dropped' });
  });

  test('other rows and the idle line are not held back', () => {
    const rows = activityOf([searchStarted(2), first]);
    const { result } = renderHook(() => useGracedActivity(rows));
    expect(result.current.items.map(item => item.id)).toEqual(['c1']);
    const idleActivity = {
      ...activityOf([first]),
      idle: { kind: 'waiting', elapsedMs: 3000, receivedAt: T0, step: 1 }
    };
    const { result: idleResult } = renderHook(() => useGracedActivity(idleActivity));
    expect(idleResult.current).toMatchObject({ items: [], idle: { kind: 'waiting' } });
  });

  test('hands back the same object when every row shows, and null for no activity', () => {
    const done = activityOf([searchStarted(2), searchCompleted(3)]);
    const { result } = renderHook(() => useGracedActivity(done));
    expect(result.current).toBe(done);
    const { result: none } = renderHook(() => useGracedActivity(undefined));
    expect(none.current).toBeNull();
  });
});
