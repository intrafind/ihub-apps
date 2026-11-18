// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `create_dashboard` and `edit_dashboard`: the tools of the `dashboard` skill.
 * A dashboard is held for the chat like a web artifact, but it has tools,
 * names and rules of its own: the skill must have been loaded in the turn, the
 * spec names the date and the sources of the data, a date far from today is
 * reported, and a change is an edit of the spec, not a page written again.
 *
 * Run: node --test server/tests/dashboard-tools.test.js
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DASHBOARD_SKILL,
  dashboardRulesLoaded,
  runCreateDashboard,
  runEditDashboard
} from '../services/documents/webArtifacts/dashboardTools.js';
import { dashboardSourceOf } from '../services/documents/webArtifacts/dashboardPreset.js';
import { runCreateWebArtifact } from '../services/documents/webArtifacts/webArtifactTools.js';
import { createTurnSkillLog } from '../services/chat/turnSkillLog.js';
import {
  clearHeldGeneratedFiles,
  heldGeneratedFile
} from '../services/documents/generatedFiles.js';
import { isSystemSkillTool, runSystemSkillTool } from '../services/systemSkillTools.js';
import { read as readChatArtifact } from '../tools/chatArtifacts.js';

const user = { id: 'u-dashboard' };
// Not a stored chat: an edit finds the files held for this turn.
const chatId = 'agent:dashboard-test';

/** A turn in which the model loaded the skill, as `activate_skill` records it. */
function loadedTurn() {
  const turnSkills = createTurnSkillLog();
  turnSkills.note(DASHBOARD_SKILL);
  return { user, chatId, turnSkills };
}

const today = new Date().toISOString().slice(0, 10);

const spec = (overrides = {}) => ({
  title: 'Marktüberblick',
  summary: 'Apple führt mit **3,6** Bio. US-$.',
  asOf: today,
  kpis: [{ label: 'Unternehmen', value: 3 }],
  blocks: [
    {
      type: 'bars',
      title: 'Marktwert (Bio. US-$)',
      source: 'markt',
      items: [
        { label: 'Apple', value: 3.6 },
        { label: 'Microsoft', value: 3.1 }
      ]
    },
    {
      type: 'bars',
      title: 'Veränderung zum Vorjahr (%)',
      items: [
        { label: 'Apple', value: 12 },
        { label: 'Intel', value: -31 }
      ]
    }
  ],
  sources: [
    {
      id: 'markt',
      name: 'Marktwerte',
      ref: 'Tabelle aus der Recherche, Runde 1',
      url: 'https://example.com/marktwerte'
    }
  ],
  ...overrides
});

const create = (data = spec(), extra = {}) =>
  runCreateDashboard({
    filename: 'markt',
    data: typeof data === 'string' ? data : JSON.stringify(data),
    ...loadedTurn(),
    ...extra
  });

const textOf = res => heldGeneratedFile(user, res.file.id, { chatId }).data.toString('utf8');

afterEach(() => clearHeldGeneratedFiles());

describe('create_dashboard', () => {
  it('lays the page out from the spec and holds it like a web artifact', async () => {
    const res = await create();
    assert.equal(res.success, true, res.error);
    assert.equal(res.file.name, 'markt.html');
    assert.equal(res.file.mimeType, 'text/plain', 'never served as active HTML');
    assert.equal(res.warnings, undefined);
    assert.match(res.message, /^Created the dashboard "markt\.html"\./);
    assert.ok(!/web artifact/i.test(res.message), 'it is a dashboard, in the result too');
    const html = textOf(res);
    assert.match(html, /id="ihub-brand-tokens"/, 'the brand colours reach the page');
    assert.match(html, /<h1|id="dashboard-data"/);
    assert.equal(dashboardSourceOf(html).spec.title, 'Marktüberblick');
  });

  it('is a system skill tool, run through the registry', async () => {
    assert.ok(isSystemSkillTool('create_dashboard'));
    assert.ok(isSystemSkillTool('edit_dashboard'));
    const res = await runSystemSkillTool('create_dashboard', {
      filename: 'registry',
      data: spec(),
      ...loadedTurn()
    });
    assert.equal(res.success, true, res.error);
  });

  it('answers a bad spec with the message that names the field, and holds nothing', async () => {
    const bad = spec();
    bad.blocks[0].items[0].value = 'many';
    const res = await create(bad);
    assert.equal(res.success, false);
    assert.match(res.error, /blocks\[0\]\.items\[0\]\.value must be a number/);
    assert.equal(res.file, undefined);
  });

  it('wants "data", and no longer takes a preset or markup', async () => {
    const none = await runCreateDashboard({ filename: 'a', ...loadedTurn() });
    assert.equal(none.success, false);
    assert.match(none.error, /pass the dashboard spec as JSON text in "data"/);
    const markup = await runCreateDashboard({
      filename: 'a',
      content: '<!DOCTYPE html><html><body>x</body></html>',
      preset: 'dashboard',
      ...loadedTurn()
    });
    assert.equal(markup.success, false, 'the page is never taken from the model');
  });

  it('shows a dashboard with a negative bar, which the old rule refused', async () => {
    const res = await create();
    assert.equal(res.success, true, res.error);
    const growth = dashboardSourceOf(textOf(res)).spec.blocks[1].items;
    assert.deepEqual(
      growth.map(item => item.value),
      [12, -31]
    );
  });
});

describe('create_dashboard: the date and the sources are required', () => {
  it('refuses a dashboard without asOf, or without a source', async () => {
    const noDate = spec();
    delete noDate.asOf;
    const a = await create(noDate);
    assert.equal(a.success, false);
    assert.match(a.error, /asOf is required/);

    const noSource = spec({ sources: [] });
    noSource.blocks.forEach(block => delete block.source);
    const b = await create(noSource);
    assert.equal(b.success, false);
    assert.match(b.error, /sources needs at least 1 entry/);
    assert.equal(b.file, undefined);
  });

  it('warns of a date far from today, so the model has to reconsider', async () => {
    const res = await create(spec({ asOf: '2024-05-20' }));
    assert.equal(res.success, true, res.error);
    assert.equal(res.warnings.length, 1);
    assert.match(res.warnings[0], /asOf "2024-05-20" is \d+ months before today/);
    assert.match(res.message, /1 warning\(s\) in "warnings" need an answer/);
    assert.match(res.message, /Do NOT answer yet/);
    assert.match(res.message, /edit_dashboard/);
  });

  it('warns of a date that has not happened yet', async () => {
    const res = await create(spec({ asOf: '2999-01-01' }));
    assert.match(res.warnings[0], /is after today/);
  });

  it('is quiet about data of the last days', async () => {
    const res = await create();
    assert.equal(res.warnings, undefined);
    assert.ok(!/Do NOT answer yet/.test(res.message));
  });
});

describe('create_dashboard: the skill must have been loaded in this turn', () => {
  it('refuses a call in a turn that did not activate the skill, and holds nothing', async () => {
    const res = await runCreateDashboard({
      filename: 'markt',
      data: spec(),
      user,
      chatId,
      turnSkills: createTurnSkillLog()
    });
    assert.equal(res.success, false);
    assert.equal(res.code, 'skill-required');
    assert.match(res.error, /^Not created: the "dashboard" skill was not loaded in this turn/);
    assert.match(res.error, /activate_skill with skill_name "dashboard"/);
    assert.match(res.error, /never written from memory/, 'the rules come with the refusal');
    assert.equal(res.file, undefined);
  });

  it('lets the call through once the model loaded the skill in this turn', async () => {
    const turnSkills = createTurnSkillLog();
    const params = { filename: 'markt', data: spec(), user, chatId, turnSkills };
    assert.equal((await runCreateDashboard(params)).success, false);
    turnSkills.note(DASHBOARD_SKILL);
    const res = await runCreateDashboard(params);
    assert.equal(res.success, true, res.error);
  });

  it('does not count another skill, nor the last turn', async () => {
    const turnSkills = createTurnSkillLog();
    turnSkills.note('web-artifacts');
    assert.equal(dashboardRulesLoaded({ turnSkills }), false);
    // A new turn has a new log: what an earlier turn loaded is not in it.
    assert.equal(dashboardRulesLoaded({ turnSkills: createTurnSkillLog() }), false);
  });

  it('accepts a skill that is active in the chat, when its instructions are in the prompt', () => {
    const turnSkills = createTurnSkillLog();
    const active = full => ({ _activeSkills: [{ name: DASHBOARD_SKILL, full }] });
    assert.equal(dashboardRulesLoaded({ turnSkills, appConfig: active(true) }), true);
    assert.equal(
      dashboardRulesLoaded({ turnSkills, appConfig: active(false) }),
      false,
      'too long for the prompt: the model has to read it with activate_skill'
    );
    assert.equal(
      dashboardRulesLoaded({
        turnSkills,
        appConfig: { _activeSkills: [{ name: 'pdf', full: true }] }
      }),
      false
    );
  });

  it('accepts what an agent run activated, and refuses an agent run that did not', () => {
    const appConfig = activated => ({
      _workflowState: { data: { _activatedSkills: activated } }
    });
    assert.equal(
      dashboardRulesLoaded({ appConfig: appConfig({ [DASHBOARD_SKILL]: { body: 'x' } }) }),
      true
    );
    assert.equal(dashboardRulesLoaded({ appConfig: appConfig({}) }), false);
  });

  it('lets a call through that no model chose, which could not have loaded a skill', () => {
    assert.equal(dashboardRulesLoaded({ appConfig: {} }), true);
    assert.equal(dashboardRulesLoaded({}), true);
  });
});

describe('create_web_artifact is for hand-built pages only', () => {
  it('has no preset: a dashboard is not made through it', async () => {
    const res = await runCreateWebArtifact({
      filename: 'a.html',
      preset: 'dashboard',
      data: JSON.stringify(spec()),
      user,
      chatId
    });
    assert.equal(res.success, false);
    assert.match(res.error, /Provide the HTML or SVG markup in "content"\./);
  });
});

describe('edit_dashboard', () => {
  it('changes the spec by exact replacements and lays the page out again', async () => {
    const first = await create();
    const res = await runEditDashboard({
      filename: 'markt.html',
      edits: [{ oldText: '"value": 3.6', newText: '"value": 3.7' }],
      user,
      chatId
    });
    assert.equal(res.success, true, res.error);
    assert.equal(res.edited, 1);
    assert.equal(res.file.name, 'markt.html');
    assert.notEqual(res.file.id, first.file.id, 'a new version');
    assert.match(res.message, /^Updated the dashboard "markt\.html"\./);
    assert.equal(dashboardSourceOf(textOf(res)).spec.blocks[0].items[0].value, 3.7);
    assert.equal(
      dashboardSourceOf(textOf(first)).spec.blocks[0].items[0].value,
      3.6,
      'the earlier version stays'
    );
    assert.equal(textOf(res).match(/id="ihub-brand-tokens"/g).length, 1);
  });

  it('needs no skill turn: a change is not a new set of figures', async () => {
    await create();
    const res = await runEditDashboard({
      filename: 'markt.html',
      edits: [{ oldText: '"title": "Marktüberblick"', newText: '"title": "Markt"' }],
      user,
      chatId,
      turnSkills: createTurnSkillLog()
    });
    assert.equal(res.success, true, res.error);
    assert.equal(dashboardSourceOf(textOf(res)).spec.title, 'Markt');
  });

  it('applies the edits to the text chat_artifacts_read shows', async () => {
    await create();
    const read = await readChatArtifact({ artifact: 'markt.html', user, chatId });
    assert.equal(read.source, 'json');
    assert.match(read.note, /edit_dashboard/);
    assert.equal(JSON.parse(read.text).title, 'Marktüberblick');
    // The model copies an oldText from the read; it matches.
    const res = await runEditDashboard({
      filename: 'markt.html',
      edits: [
        {
          oldText: '"label": "Intel",\n          "value": -31',
          newText: '"label": "Intel",\n          "value": -28'
        }
      ],
      user,
      chatId
    });
    assert.equal(res.success, true, res.error);
    assert.equal(dashboardSourceOf(textOf(res)).spec.blocks[1].items[1].value, -28);
  });

  it('keeps the rules: a change cannot take away the sources or the date', async () => {
    await create();
    const noSources = await runEditDashboard({
      filename: 'markt.html',
      edits: [{ oldText: '"sources": [', newText: '"unused": [' }],
      user,
      chatId
    });
    assert.equal(noSources.success, false);
    assert.match(noSources.error, /sources is required/);

    const noDate = await runEditDashboard({
      filename: 'markt.html',
      edits: [{ oldText: `"asOf": "${today}",`, newText: '' }],
      user,
      chatId
    });
    assert.match(noDate.error, /asOf is required/);
  });

  it('warns of a date the edit moved far from today, and only then', async () => {
    await create();
    const moved = await runEditDashboard({
      filename: 'markt.html',
      edits: [{ oldText: `"asOf": "${today}"`, newText: '"asOf": "2024-05-20"' }],
      user,
      chatId
    });
    assert.equal(moved.success, true, moved.error);
    assert.match(moved.warnings[0], /asOf "2024-05-20"/);

    // An edit elsewhere on a dashboard that is old already does not repeat it.
    const other = await runEditDashboard({
      filename: 'markt.html',
      edits: [{ oldText: '"title": "Marktüberblick"', newText: '"title": "Markt"' }],
      user,
      chatId
    });
    assert.equal(other.success, true, other.error);
    assert.equal(other.warnings, undefined);
  });

  it('refuses text that is missing, an edit that breaks the JSON, and one that changes nothing', async () => {
    await create();
    const missing = await runEditDashboard({
      filename: 'markt.html',
      edits: [{ oldText: 'nowhere in the spec', newText: 'x' }],
      user,
      chatId
    });
    assert.match(missing.error, /edits\[0\]\.oldText does not occur/);

    const broken = await runEditDashboard({
      filename: 'markt.html',
      edits: [{ oldText: '"summary": "', newText: '"summary": ' }],
      user,
      chatId
    });
    assert.equal(broken.success, false);
    assert.match(broken.error, /invalid JSON/);

    const same = await runEditDashboard({
      filename: 'markt.html',
      edits: [{ oldText: 'Marktüberblick', newText: 'Marktüberblick' }],
      user,
      chatId
    });
    assert.match(same.error, /change nothing/);
  });

  it('changes only dashboards: another file is pointed to its own tool', async () => {
    const page = await runCreateWebArtifact({
      filename: 'calc.html',
      content: '<!DOCTYPE html><html><head><title>Calc</title></head><body>x</body></html>',
      user,
      chatId
    });
    assert.equal(page.success, true, page.error);
    const res = await runEditDashboard({
      filename: 'calc.html',
      edits: [{ oldText: 'x', newText: 'y' }],
      user,
      chatId
    });
    assert.equal(res.success, false);
    assert.match(res.error, /is not a dashboard made by create_dashboard/);
    assert.match(res.error, /edit_web_artifact/);

    const none = await runEditDashboard({
      filename: 'missing.html',
      edits: [{ oldText: 'x', newText: 'y' }],
      user,
      chatId
    });
    assert.equal(none.success, false);
  });

  it('reads a hand-built page as it is, not as a spec', async () => {
    await create();
    const page = await runCreateWebArtifact({
      filename: 'x.html',
      content: '<!DOCTYPE html><html><body>hand-built</body></html>',
      user,
      chatId
    });
    assert.equal(page.success, true, page.error);
    const read = await readChatArtifact({ artifact: 'x.html', user, chatId });
    assert.equal(read.source, undefined);
    assert.match(read.text, /hand-built/);
  });
});
