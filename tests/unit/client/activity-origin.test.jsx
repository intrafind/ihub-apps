// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * "Say where an answer came from" (#3668), client activity: the headline as
 * segments (skills first, then one per origin), the rows' origin phrases, the
 * declared "no results", "N opened", skill rows, the Technical details switch
 * and the announcer. The server decides origin, count and outcome; nothing
 * here may infer them.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { createStreamState, reduceRunEvents, getRun } from '../../../shared/run/runReducer.js';
import { buildToolActivity } from '../../../shared/run/toolActivity.js';
import ToolActivity from '../../../client/src/features/chat/components/ToolActivity';
import {
  headlineSegments,
  isOpened,
  activeLabel
} from '../../../client/src/features/chat/activityHeadline.js';
import {
  createAnnouncerState,
  deriveAnnouncements
} from '../../../client/src/features/chat/deriveAnnouncements.js';

beforeEach(() => {
  window.localStorage.clear();
});

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

const ts = seq => `2026-11-13T10:00:${String(seq).padStart(2, '0')}.000Z`;
const env = (seq, type, data = {}) => ({ v: 2, seq, runId: 'r1', ts: ts(seq), type, data });
const run = frames =>
  getRun(
    reduceRunEvents(createStreamState('c1'), [env(1, 'run/started', { kind: 'chat' }), ...frames]),
    'r1'
  );
const activityOf = frames => buildToolActivity(run(frames));
const end = seq => env(seq, 'run/ended', { status: 'completed' });

const started = (seq, callId, toolId, data) =>
  env(seq, 'tool/started', {
    step: 1,
    callId,
    toolId,
    name: toolId,
    execution: 'server',
    args: {},
    ...data
  });
const completed = (seq, callId, toolId, data) =>
  env(seq, 'tool/completed', { step: 1, callId, toolId, name: toolId, durationMs: 1200, ...data });
const sources = (seq, callId, toolId, items) =>
  env(seq, 'sources/added', { step: 1, callId, toolId, items, queries: [] });
const hit = (n, extra = {}) => ({
  id: `url:site${n}.example`,
  provider: 'web',
  kind: 'page',
  url: `https://site${n}.example/`,
  title: `Page ${n}`,
  private: false,
  ...extra
});

const web = {
  activityKind: 'search',
  activityScope: 'web',
  activityOrigin: 'web',
  integration: 'Brave Search'
};
const project = { activityKind: 'search', activityScope: 'documents', activityOrigin: 'project' };
const read = { activityKind: 'fetch', activityScope: 'web', activityOrigin: 'web' };

/** The run of the issue's screenshot: a web search (5 results, 3 pages opened) and an empty project search. */
const screenshotRun = () => [
  started(2, 'w1', 'braveSearch', { ...web, args: { query: 'IntraFind iFinder6' } }),
  completed(3, 'w1', 'braveSearch', { resultCount: 5 }),
  sources(
    4,
    'w1',
    'braveSearch',
    [1, 2, 3, 4, 5].map(n => hit(n))
  ),
  started(5, 'p1', 'knowledge_search', { ...project, args: { query: 'iFinder6' } }),
  completed(6, 'p1', 'knowledge_search', { resultCount: 0 }),
  ...[1, 2, 3].flatMap((n, i) => [
    started(7 + i * 2, `r${n}`, 'read_url', {
      ...read,
      args: { url: `https://site${n}.example/` }
    }),
    completed(8 + i * 2, `r${n}`, 'read_url', { readOutcome: 'opened' })
  ]),
  end(20)
];

const identity = (key, options = {}) =>
  options.count !== undefined ? `${key}:${options.count}` : key;

describe('the headline as segments', () => {
  test('the screenshot run reads as two segments: Web with its own counts, Project with no results', () => {
    const { segments, more } = headlineSegments(identity, activityOf(screenshotRun()).items);
    expect(more).toEqual([]);
    expect(segments.map(segment => [segment.type, segment.origin, segment.icon])).toEqual([
      ['origin', 'web', 'globe-alt'],
      ['origin', 'project', 'folder']
    ]);
    expect(segments[0].facts.map(fact => fact.text)).toEqual([
      'toolActivity.results:5',
      'toolActivity.openedCount:3',
      'toolActivity.via'
    ]);
    // The provider is the last fact of its own segment, not a trailing word of the line.
    expect(segments[1].facts.map(fact => fact.text)).toEqual(['toolActivity.noResults']);
    expect(segments[1].facts[0].tone).toBe('empty');
  });

  test('the three page reads belong to the web segment, whatever search came before them', () => {
    render(<ToolActivity activity={activityOf(screenshotRun())} loading={false} />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    const rows = screen.getAllByRole('listitem').filter(row => row.parentElement.tagName === 'OL');
    const phrases = rows.map(row => row.textContent);
    expect(phrases[1]).toContain('toolActivity.origin.project.rowSearched');
    for (const row of rows.slice(2))
      expect(row.textContent).toContain('toolActivity.origin.web.rowOpened');
    // Each row's lead icon is its origin's, so a read does not look like a child of the project search.
    const lead = row => within(row).getAllByTestId('icon')[0].dataset.name;
    expect(lead(rows[1])).toBe('folder');
    expect(lead(rows[2])).toBe('globe-alt');
  });

  test('"no results" is only ever a count the server declared', () => {
    const empty = frames => headlineSegments(identity, activityOf(frames).items).segments[0].facts;
    const search = [started(2, 'p1', 'knowledge_search', { ...project, args: { query: 'q' } })];
    // Declared zero.
    expect(
      empty([...search, completed(3, 'p1', 'knowledge_search', { resultCount: 0 }), end(4)])
    ).toEqual([expect.objectContaining({ key: 'noResults' })]);
    // Nothing declared and no sources: unknown, so the segment says nothing about results.
    expect(empty([...search, completed(3, 'p1', 'knowledge_search'), end(4)])).toEqual([]);
    // A failed search is never "no results".
    const failed = empty([
      ...search,
      completed(3, 'p1', 'knowledge_search', { resultCount: 0, error: { message: 'boom' } }),
      end(4)
    ]);
    expect(failed.map(fact => fact.key)).toEqual(['failed']);
  });

  test('"N opened" counts only reads that delivered text', () => {
    const readOf = (id, done, extra = {}) =>
      [
        started(10, id, 'read_url', { ...read, args: { url: `https://${id}.example/` } }),
        completed(11, id, 'read_url', done)
      ].concat(extra.sources ? [sources(12, id, 'read_url', extra.sources)] : []);
    const items = activityOf([
      ...readOf('ok', { readOutcome: 'opened' }),
      ...readOf('empty', { readOutcome: 'empty' }),
      ...readOf('nomark', {}),
      ...readOf('unreadable', {}, { sources: [hit(1, { read: { ok: false } })] }),
      ...readOf('failed', { error: { message: 'down' } }),
      end(30)
    ]).items;
    expect(items.map(isOpened)).toEqual([true, false, true, false, false]);
    const [web] = headlineSegments(identity, items).segments;
    expect(web.facts.map(fact => fact.key)).toEqual(['opened', 'failed']);
    expect(web.facts[0].text).toBe('toolActivity.openedCount:2');
  });

  test('rows the server said nothing about (old chats) are one neutral segment with no origin words', () => {
    const items = activityOf([
      started(2, 'a', 'braveSearch', {
        activityKind: 'search',
        activityScope: 'web',
        args: { query: 'q' }
      }),
      completed(3, 'a', 'braveSearch'),
      sources(4, 'a', 'braveSearch', [hit(1), hit(2)]),
      started(5, 'b', 'knowledge_search', {
        activityKind: 'search',
        activityScope: 'documents',
        args: { query: 'q2' }
      }),
      completed(6, 'b', 'knowledge_search'),
      end(7)
    ]).items;
    expect(items.every(item => item.origin === null)).toBe(true);
    const { segments } = headlineSegments(identity, items);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ type: 'neutral', icon: null, noun: null });
    expect(segments[0].facts.map(fact => fact.text)).toEqual([
      'toolActivity.results:2',
      'toolActivity.searches:2'
    ]);
    // The old `scope` is not read: nothing says "web" or "documents".
    render(<ToolActivity activity={{ items, reading: null }} loading={false} />);
    expect(screen.getByRole('button')).not.toHaveTextContent('answerBasis.kind');
  });

  test('two origins are named, the rest is +N, and the button names every one', () => {
    const items = activityOf([
      started(2, 'a', 'braveSearch', { ...web, args: { query: 'q' } }),
      completed(3, 'a', 'braveSearch', { resultCount: 1 }),
      started(4, 'b', 'knowledge_search', { ...project, args: { query: 'q' } }),
      completed(5, 'b', 'knowledge_search', { resultCount: 1 }),
      started(6, 'c', 'iFinder_search', {
        activityKind: 'search',
        activityOrigin: 'ifinder',
        args: { query: 'q' }
      }),
      completed(7, 'c', 'iFinder_search', { resultCount: 2 }),
      end(8)
    ]).items;
    const { named, more } = headlineSegments(identity, items);
    expect(named.map(segment => segment.origin)).toEqual(['web', 'project']);
    expect(more.map(segment => segment.origin)).toEqual(['ifinder']);
    render(<ToolActivity activity={{ items, reading: null }} loading={false} />);
    const button = screen.getByRole('button');
    expect(button).toHaveTextContent('chatMessage.answerBasis.more:1');
    // The hidden origin is in the button's text for a screen reader, with no ellipsis anywhere.
    expect(button).toHaveTextContent('chatMessage.answerBasis.kind.ifinder');
    expect(button.querySelector('.truncate')).toBeNull();
  });

  test('a connected system is its own segment, named by its label, with calls and no provider', () => {
    const items = activityOf([
      started(2, 'j', 'jira_find', {
        activityKind: 'tool',
        activityOrigin: 'integration',
        integration: 'Jira',
        title: 'Search issues'
      }),
      completed(3, 'j', 'jira_find'),
      end(4)
    ]).items;
    const { segments } = headlineSegments(identity, items);
    expect(segments[0]).toMatchObject({ origin: 'integration', noun: 'Jira', icon: 'link' });
    expect(segments[0].facts.map(fact => fact.text)).toEqual(['toolActivity.calls:1']);
  });
});

describe('streaming wording', () => {
  test('the live line names the origin, and says nothing it was not told', () => {
    const label = (item, reading = null) => activeLabel(identity, item, reading);
    const search = origin => ({ status: 'running', kind: 'search', query: 'q', origin });
    expect(label(search('web'))).toBe('toolActivity.origin.web.searchingFor');
    expect(label(search('project'))).toBe('toolActivity.origin.project.searchingFor');
    expect(label(search('ifinder'))).toBe('toolActivity.origin.ifinder.searchingFor');
    expect(label(search('documents'))).toBe('toolActivity.origin.documents.searchingFor');
    expect(label({ ...search('web'), query: null })).toBe('toolActivity.origin.web.searching');
    // No origin: the generic words, never a guess.
    expect(label(search(null))).toBe('toolActivity.searchingFor');
    expect(label({ ...search(null), query: null })).toBe('toolActivity.searchingGeneric');
    // A read.
    expect(
      label({ status: 'running', kind: 'fetch', origin: 'web', url: 'https://a.example/x' })
    ).toBe('toolActivity.origin.web.opening');
    expect(label({ status: 'running', kind: 'fetch', origin: null })).toBe(
      'toolActivity.openingGeneric'
    );
  });
});

describe('skills in the activity block', () => {
  const activate = (seq, name, activatedBy) =>
    env(seq, 'tool/progress', {
      phase: 'skill.activation',
      message: name,
      data: { skillName: name, skillId: name.toLowerCase(), activatedBy, description: '' }
    });

  test('a skill leads the collapsed line with its reason and is not an origin', () => {
    const items = activityOf([
      activate(2, 'Contract review', 'user'),
      started(3, 'a', 'braveSearch', { ...web, args: { query: 'q' } }),
      completed(4, 'a', 'braveSearch', { resultCount: 1 }),
      end(5)
    ]).items;
    const { segments } = headlineSegments(identity, items);
    expect(segments.map(segment => segment.type)).toEqual(['skill', 'origin']);
    expect(segments[0]).toMatchObject({
      name: 'Contract review',
      reason: 'toolActivity.skillByUser'
    });
  });

  test('every route says why: manually, by the model, by the app, kept from an earlier message', () => {
    const reason = by =>
      headlineSegments(identity, activityOf([activate(2, 'S', by), end(3)]).items).segments[0]
        .reason;
    expect(reason('user')).toBe('toolActivity.skillByUser');
    expect(reason('model')).toBe('toolActivity.skillByModel');
    expect(reason('app')).toBe('toolActivity.skillByApp');
    expect(reason('chat')).toBe('toolActivity.skillByChat');
    // An answer stored before the change: nothing is guessed.
    expect(reason(undefined)).toBeNull();
  });

  test('three or more skills are one names-only segment, and skills never count in +N', () => {
    const items = activityOf([
      activate(2, 'A', 'user'),
      activate(3, 'B', 'app'),
      activate(4, 'C', 'chat'),
      started(5, 'a', 'braveSearch', { ...web, args: { query: 'q' } }),
      completed(6, 'a', 'braveSearch', { resultCount: 1 }),
      started(7, 'b', 'knowledge_search', { ...project, args: { query: 'q' } }),
      completed(8, 'b', 'knowledge_search', { resultCount: 1 }),
      end(9)
    ]).items;
    const { segments, more } = headlineSegments(identity, items);
    expect(segments[0]).toMatchObject({ type: 'skills', names: ['A', 'B', 'C'] });
    expect(segments.slice(1).map(segment => segment.origin)).toEqual(['web', 'project']);
    expect(more).toEqual([]);
  });

  test('a turn with only a skill still has the block: collapsed it is the segment, expanded one row', () => {
    const activity = activityOf([activate(2, 'Brand voice', 'app'), end(3)]);
    render(<ToolActivity activity={activity} loading={false} />);
    const button = screen.getByRole('button');
    expect(button).toHaveTextContent('toolActivity.skillLabel Brand voice');
    expect(button).toHaveTextContent('toolActivity.skillByApp');
    fireEvent.click(button);
    const row = screen.getByRole('listitem');
    expect(row).toHaveTextContent('Brand voice');
    // A status, not a control: no tab stop, no tooltip, no switch for a row without details.
    expect(row.querySelectorAll('a, button, [tabindex], [title]')).toHaveLength(0);
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    // Every skill is drawn once as a row and once as the headline segment, never as a chip above.
    expect(screen.getAllByText('Brand voice')).toHaveLength(2);
  });

  test('the skill glyph is purple academic-cap, never the footer’s sparkles', () => {
    render(
      <ToolActivity activity={activityOf([activate(2, 'S', 'user'), end(3)])} loading={false} />
    );
    const names = screen.getAllByTestId('icon').map(icon => icon.dataset.name);
    expect(names).toContain('academic-cap');
    expect(names).not.toContain('sparkles');
  });
});

describe('the Technical details switch', () => {
  const finished = () => activityOf(screenshotRun());
  const open = () => fireEvent.click(screen.getByRole('button', { expanded: false }));

  test('is off by default: no argument names, tool ids or durations', () => {
    render(<ToolActivity activity={finished()} loading={false} />);
    open();
    const toggle = screen.getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(toggle).toHaveAccessibleDescription('toolActivity.technicalDetailsHint');
    expect(screen.queryByText('braveSearch')).not.toBeInTheDocument();
    expect(screen.queryByText('toolActivity.detailDuration')).not.toBeInTheDocument();
    // The query, hits and hosts stay.
    expect(screen.getByText('IntraFind iFinder6')).toBeInTheDocument();
    expect(screen.getByText('Page 1')).toBeInTheDocument();
  });

  test('on, shows the tool and the duration of each row, and is remembered', () => {
    render(<ToolActivity activity={finished()} loading={false} />);
    open();
    fireEvent.click(screen.getByRole('switch'));
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('braveSearch')).toBeInTheDocument();
    expect(screen.getAllByText('toolActivity.detailDuration').length).toBeGreaterThan(0);
    expect(window.localStorage.getItem('ihub.activity.technicalDetails')).toBe('1');
    cleanup();
    render(<ToolActivity activity={finished()} loading={false} />);
    open();
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  test('is not there while the turn is still going', () => {
    render(<ToolActivity activity={finished()} loading />);
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  test('the page works when storage is blocked', () => {
    const blocked = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const writes = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    render(<ToolActivity activity={finished()} loading={false} />);
    open();
    // Nothing is remembered, but the switch still flips for this page.
    const before = screen.getByRole('switch').getAttribute('aria-checked');
    fireEvent.click(screen.getByRole('switch'));
    expect(screen.getByRole('switch')).toHaveAttribute(
      'aria-checked',
      before === 'true' ? 'false' : 'true'
    );
    blocked.mockRestore();
    writes.mockRestore();
  });
});

describe('focus when the list closes by itself', () => {
  test('moves to the headline button instead of falling onto the page', () => {
    const activity = activityOf(screenshotRun());
    const { rerender } = render(<ToolActivity activity={activity} loading />);
    const link = screen.getAllByRole('link')[0];
    act(() => link.focus());
    expect(document.activeElement).toBe(link);
    rerender(<ToolActivity activity={activity} loading={false} />);
    expect(screen.getByRole('button', { expanded: false })).toHaveFocus();
  });

  test('is left alone when the user closed it, or focus was elsewhere', () => {
    const activity = activityOf(screenshotRun());
    const { rerender } = render(<ToolActivity activity={activity} loading />);
    rerender(<ToolActivity activity={activity} loading={false} />);
    expect(screen.getByRole('button')).not.toHaveFocus();
  });
});

describe('the announcer', () => {
  const messageOf = frames => [
    { id: 'm1', role: 'assistant', loading: true, toolActivity: activityOf(frames) }
  ];
  const derive = message =>
    deriveAnnouncements(createAnnouncerState(), message, { t: identity, now: Date.now() });

  test('says once that a declared-empty search found nothing, in the origin’s words', () => {
    const frames = [
      started(2, 'p1', 'knowledge_search', { ...project, args: { query: 'q' } }),
      completed(3, 'p1', 'knowledge_search', { resultCount: 0 })
    ];
    const { announcements } = derive(messageOf(frames));
    expect(announcements.map(entry => entry.text)).toContain(
      'toolActivity.announce.noResults.project'
    );
  });

  test('is silent about results that were not declared', () => {
    const frames = [
      started(2, 'p1', 'knowledge_search', { ...project, args: { query: 'q' } }),
      completed(3, 'p1', 'knowledge_search')
    ];
    const text = derive(messageOf(frames)).announcements.map(entry => entry.text);
    expect(text.some(line => String(line).includes('noResults'))).toBe(false);
  });
});
