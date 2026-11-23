// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The pure parts of the chat builder's conversation (plan
 * concepts/app-builder-rework-2026-11/04-chat-builder-implementation-plan.md,
 * sections 2.2 to 2.5): how a change is merged over the form, when it can
 * still be applied or undone, what a turn sends, what a ticked suggestion
 * adds, the line diff, the error sentences and the stakes line.
 */

import {
  REVISE_AUTHOR_TEXT_MAX,
  REVISE_BUILDER_TEXT_MAX,
  REVISE_CONVERSATION_MAX,
  appRevisionKeys,
  applyRevisionPatch
} from '../../../shared/appRevision.js';
import {
  changeKeysOf,
  changeSections,
  changedLanguages,
  contentChangedSince,
  draftOf,
  linesOf,
  offeredSuggestions,
  readConversation,
  restoreValues,
  sameValue,
  stillApplied,
  suggestionChanges,
  unsavedOutsideChange,
  valuesOf,
  warningKey,
  wireConversation,
  writeConversation
} from '../../../client/src/features/admin/components/app-conversation/conversationState';
import {
  diffLines,
  foldUnchanged
} from '../../../client/src/features/admin/components/app-conversation/lineDiff';
import { reviseErrorMessage } from '../../../client/src/features/admin/components/app-conversation/reviseErrors';
import {
  adminStakes,
  personalStakes
} from '../../../client/src/features/admin/components/app-conversation/stakes';
import { builderEntry } from '../../../client/src/features/admin/components/app-conversation/useConversation';

const FORM = Object.freeze({
  id: 'helper',
  type: 'chat',
  enabled: true,
  name: { en: 'Helper', de: 'Helfer' },
  description: { en: 'Helps' },
  system: { en: 'Be friendly.', de: 'Sei freundlich.' },
  color: '#4F46E5',
  icon: 'chat-bubbles',
  websearch: { enabled: false },
  preferredModel: 'gpt'
});

describe('shared/appRevision', () => {
  test('the keys a revision may change, per target', () => {
    expect(appRevisionKeys('admin')).toEqual([
      'name',
      'description',
      'system',
      'prompt',
      'messagePlaceholder',
      'variables',
      'starterPrompts',
      'category',
      'color',
      'icon'
    ]);
    const personal = appRevisionKeys('personal');
    expect(personal).not.toContain('category');
    expect(personal).not.toContain('preferredModel');
    expect(personal).not.toContain('capabilities');
  });

  test('the limits of a request', () => {
    expect(REVISE_CONVERSATION_MAX).toBe(12);
    expect(REVISE_AUTHOR_TEXT_MAX).toBe(1000);
    expect(REVISE_BUILDER_TEXT_MAX).toBe(500);
  });

  test('applyRevisionPatch replaces whole values of the patched keys only', () => {
    const next = applyRevisionPatch(FORM, { system: { en: 'Be formal.', de: 'Sei freundlich.' } });
    expect(next.system).toEqual({ en: 'Be formal.', de: 'Sei freundlich.' });
    expect(next.name).toEqual(FORM.name);
    expect(next.websearch).toEqual(FORM.websearch);
    expect(FORM.system.en).toBe('Be friendly.');
    expect(applyRevisionPatch(FORM, {})).toEqual(FORM);
    // `null` removes a key (an emptied message template).
    expect(
      applyRevisionPatch({ ...FORM, prompt: { en: 'x' } }, { prompt: null })
    ).not.toHaveProperty('prompt');
  });
});

describe('what a turn sends and when a change still applies', () => {
  test('draftOf sends the content keys only, and leaves out empty values', () => {
    expect(draftOf(FORM, 'admin')).toEqual({
      name: FORM.name,
      description: FORM.description,
      system: FORM.system,
      color: FORM.color,
      icon: FORM.icon
    });
    expect(draftOf({ ...FORM, color: '' }, 'personal')).not.toHaveProperty('color');
  });

  test('a hand edit of a content key makes a proposed change stale; other keys do not', () => {
    const base = draftOf(FORM, 'admin');
    expect(contentChangedSince(FORM, base, 'admin')).toBe(false);
    expect(contentChangedSince({ ...FORM, name: { en: 'Other' } }, base, 'admin')).toBe(true);
    // Web search is not a content key: the change was made for the same content.
    expect(contentChangedSince({ ...FORM, websearch: { enabled: true } }, base, 'admin')).toBe(
      false
    );
  });

  test('sameValue ignores the order of keys', () => {
    expect(sameValue({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toBe(true);
    expect(sameValue({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameValue(undefined, null)).toBe(true);
  });

  test('Undo is possible only while every changed key holds the applied value', () => {
    const changes = { system: { en: 'Be formal.' } };
    const applied = valuesOf(applyRevisionPatch(FORM, changes), ['system']);
    const saved = applyRevisionPatch(FORM, changes);
    expect(stillApplied(saved, applied)).toBe(true);
    expect(stillApplied({ ...saved, system: { en: 'Edited later.' } }, applied)).toBe(false);
    // A key the change did not touch may change freely.
    expect(stillApplied({ ...saved, name: { en: 'Renamed' } }, applied)).toBe(true);
  });

  test('a change that removed a key still counts as applied while the key stays absent', () => {
    const saved = applyRevisionPatch({ ...FORM, prompt: { en: 'x' } }, { prompt: null });
    const applied = valuesOf(saved, ['prompt']);
    expect(stillApplied(saved, applied)).toBe(true);
    expect(stillApplied({ ...saved, prompt: { en: 'typed again' } }, applied)).toBe(false);
  });

  test('restoreValues puts back earlier values and removes keys that were not there', () => {
    const before = valuesOf(FORM, ['system', 'starterPrompts']);
    expect(before.missing).toEqual(['starterPrompts']);
    const changed = { ...FORM, system: { en: 'X' }, starterPrompts: [{ title: { en: 'Hi' } }] };
    const restored = restoreValues(changed, before);
    expect(restored.system).toEqual(FORM.system);
    expect(restored).not.toHaveProperty('starterPrompts');
  });

  test('wireConversation sends the last 12 entries within the limits, a question by its wording', () => {
    const entries = Array.from({ length: 14 }, (_, index) => ({
      id: index + 1,
      role: index % 2 === 0 ? 'author' : 'builder',
      kind: 'message',
      text: index === 13 ? 'b'.repeat(900) : `entry ${index + 1}`
    }));
    entries[12] = { id: 13, role: 'author', text: 'a'.repeat(1500) };
    entries[11] = {
      id: 12,
      role: 'builder',
      kind: 'question',
      text: 'Intro',
      question: { text: 'Which tone?', choices: ['A'] }
    };
    const wire = wireConversation(entries);
    expect(wire).toHaveLength(12);
    expect(wire[0].text).toBe('entry 3');
    expect(wire[9]).toEqual({ role: 'builder', kind: 'question', text: 'Which tone?' });
    expect(wire[10]).toEqual({ role: 'author', text: 'a'.repeat(1000) });
    expect(wire[11].text).toHaveLength(500);
    expect(wire.every(entry => entry.role === 'author' || entry.kind)).toBe(true);
  });

  test('the conversation is kept per tab, and broken storage gives an empty one', () => {
    writeConversation('k', {
      entries: [{ id: 1, role: 'author', text: 'Hi' }],
      turns: 1,
      nextId: 2
    });
    expect(readConversation('k').entries).toEqual([{ id: 1, role: 'author', text: 'Hi' }]);
    window.sessionStorage.setItem('k', '{broken');
    expect(readConversation('k').entries).toEqual([]);
    const spy = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readConversation('k').entries).toEqual([]);
    spy.mockRestore();
    window.sessionStorage.clear();
  });

  test("unsaved edits are every difference from the saved app outside the change's own keys", () => {
    const saved = { name: { en: 'A' }, description: { en: 'D' }, system: { en: 'S' }, x: 1 };
    // An unsaved description goes with a change of the instructions: content keys count too.
    expect(unsavedOutsideChange({ ...saved, description: { en: 'D2' } }, saved, ['system'])).toBe(
      true
    );
    // The change's own key is what Apply writes; it is not an "other" edit.
    expect(unsavedOutsideChange({ ...saved, system: { en: 'S2' } }, saved, ['system'])).toBe(false);
    expect(unsavedOutsideChange({ ...saved, x: 2 }, saved, ['system'])).toBe(true);
    expect(unsavedOutsideChange({ ...saved, capabilities: { upload: true } }, saved, [])).toBe(
      true
    );
    expect(unsavedOutsideChange(saved, null, ['system'])).toBe(false);
  });

  test('the keys of a change: patch and ticked suggestions before Apply, what Apply set after', () => {
    const entry = {
      kind: 'change',
      status: 'proposed',
      patch: { system: { en: 'S2' }, allowEmptyContent: true },
      suggestions: { websearch: true, integrations: [{ id: 'jira', label: 'Jira' }] }
    };
    expect(changeKeysOf('admin', FORM, entry)).toEqual(['system', 'allowEmptyContent']);
    expect(
      changeKeysOf('admin', FORM, entry, { webSearch: true, integrationIds: ['jira'] })
    ).toEqual(['system', 'allowEmptyContent', 'websearch', 'integrations']);
    expect(
      changeKeysOf('personal', {}, entry, { webSearch: false, integrationIds: ['jira'] })
    ).toEqual(['system', 'allowEmptyContent', 'capabilities']);
    const applied = {
      ...entry,
      status: 'applied',
      before: { values: { system: { en: 'S' } }, missing: ['prompt'] },
      applied: { values: { system: { en: 'S2' } }, missing: ['prompt'] }
    };
    expect(changeKeysOf('admin', FORM, applied)).toEqual(['system', 'prompt']);
  });

  test('a change without a sentence is still sent, so the question count resets', () => {
    const wire = wireConversation([
      { id: 1, role: 'author', text: 'Make it formal' },
      { id: 2, role: 'builder', kind: 'question', text: '', question: { text: 'Which tone?' } },
      { id: 3, role: 'author', text: 'Formal' },
      { id: 4, role: 'builder', kind: 'change', text: '' },
      { id: 5, role: 'builder', kind: 'message', text: ' ' },
      { id: 6, role: 'author', text: 'Shorter' }
    ]);
    expect(wire).toEqual([
      { role: 'author', text: 'Make it formal' },
      { role: 'builder', kind: 'question', text: 'Which tone?' },
      { role: 'author', text: 'Formal' },
      { role: 'builder', kind: 'change', text: '' },
      { role: 'author', text: 'Shorter' }
    ]);
  });

  test('a save that was running when the page went away is settled on read', () => {
    writeConversation('k', {
      entries: [
        { id: 1, role: 'builder', kind: 'change', text: 'A', status: 'applying' },
        { id: 2, role: 'builder', kind: 'change', text: 'B', status: 'undoing' },
        { id: 3, role: 'builder', kind: 'change', text: 'C', status: 'applied' }
      ],
      turns: 3,
      nextId: 4
    });
    expect(readConversation('k').entries.map(entry => entry.status)).toEqual([
      'proposed',
      'applied',
      'applied'
    ]);
    window.sessionStorage.clear();
  });
});

describe('answers and suggestions', () => {
  test('builderEntry keeps a change with the content it was made for', () => {
    const entry = builderEntry(
      {
        reply: 'change',
        text: 'Done',
        patch: { system: { en: 'X' } },
        changed: ['system'],
        warnings: [{ code: 'NO_CHANGE' }],
        suggestions: { websearch: true }
      },
      3,
      { system: { en: 'Y' } }
    );
    expect(entry).toMatchObject({
      id: 3,
      kind: 'change',
      status: 'proposed',
      baseSnapshot: { system: { en: 'Y' } }
    });
    // A change without a patch is a message.
    expect(builderEntry({ reply: 'change', text: 'Nothing', patch: {} }, 4, {}).kind).toBe(
      'message'
    );
    expect(
      builderEntry({ reply: 'question', text: 'Q', question: { text: 'Q', choices: ['', 'A'] } }, 5)
        .question.choices
    ).toEqual(['A']);
  });

  test('only suggestions the app does not have yet are offered, and ticks become whole values', () => {
    const suggestions = {
      websearch: true,
      integrations: [
        { id: 'jira', label: 'Jira', actions: ['search'] },
        { id: 'bound', label: 'Bound' }
      ]
    };
    const admin = { ...FORM, integrations: { bound: {} } };
    const offered = offeredSuggestions('admin', admin, suggestions);
    expect(offered.webSearch).toBe(true);
    expect(offered.integrations.map(system => system.id)).toEqual(['jira']);
    expect(
      suggestionChanges('admin', admin, offered, { webSearch: true, integrationIds: ['jira'] })
    ).toEqual({
      websearch: { enabled: true },
      integrations: { bound: {}, jira: { actions: ['search'] } }
    });
    expect(suggestionChanges('admin', admin, offered, {})).toEqual({});

    const personal = { capabilities: { webSearch: false, integrations: [] } };
    const personalOffered = offeredSuggestions('personal', personal, suggestions);
    expect(
      suggestionChanges('personal', personal, personalOffered, {
        webSearch: true,
        integrationIds: ['jira']
      })
    ).toEqual({
      capabilities: { webSearch: true, integrations: [{ id: 'jira', actions: ['search'] }] }
    });
  });

  test('a field line names the type and the default, so changing either changes the line', () => {
    const t = (key, values) => (values ? `${key}:${values.value}` : key);
    const field = {
      name: 'tone',
      label: { en: 'Tone' },
      type: 'select',
      required: true,
      defaultValue: { en: 'Friendly' },
      predefinedValues: [
        { value: 'friendly', label: { en: 'Friendly' } },
        { value: 'formal', label: { en: 'Formal' } }
      ]
    };
    const [line] = linesOf('variables', [field], 'en', t);
    expect(line).toBe(
      'Tone admin.apps.conversation.line.required · admin.apps.edit.typeSelect (Friendly, Formal)' +
        ' · admin.apps.conversation.line.default:Friendly'
    );
    const variants = [
      { ...field, type: 'string', predefinedValues: undefined },
      { ...field, defaultValue: { en: 'Formal' } },
      { ...field, defaultValue: undefined },
      { ...field, type: 'boolean', predefinedValues: undefined, defaultValue: { en: 'true' } }
    ];
    for (const variant of variants) {
      expect(linesOf('variables', [variant], 'en', t)[0]).not.toBe(line);
    }
    // A type this client does not know is shown as it is.
    expect(linesOf('variables', [{ name: 'x', type: 'color' }], 'en', t)[0]).toBe('x · color');
  });

  test('changeSections names each changed part in plain words, colour and icon together', () => {
    expect(changeSections(['system', 'color', 'icon', 'allowEmptyContent']).map(s => s.id)).toEqual(
      ['system', 'look']
    );
    expect(changedLanguages('system', { en: 'a', de: 'b' }, { en: 'c', de: 'b' }, 'en')).toEqual([
      'en'
    ]);
  });
});

describe('the line diff', () => {
  test('an 8,000-character change shows every removed and added line in full', () => {
    const before = Array.from({ length: 100 }, (_, i) => `Old rule ${i}: ${'x'.repeat(70)}`);
    const after = Array.from({ length: 100 }, (_, i) => `New rule ${i}: ${'y'.repeat(70)}`);
    expect(after.join('\n').length).toBeGreaterThan(8000);
    const rows = foldUnchanged(diffLines(before.join('\n'), after.join('\n')));
    expect(rows.filter(row => row.type === 'del').map(row => row.text)).toEqual(before);
    expect(rows.filter(row => row.type === 'ins').map(row => row.text)).toEqual(after);
    expect(rows.some(row => row.type === 'fold')).toBe(false);
  });

  test('unchanged runs longer than 6 lines fold, with context next to the change', () => {
    const same = Array.from({ length: 10 }, (_, i) => `line ${i}`);
    const rows = foldUnchanged(diffLines([...same, 'old'], [...same, 'new']));
    expect(rows[0]).toMatchObject({ type: 'fold' });
    expect(rows[0].lines).toHaveLength(8);
    expect(rows.slice(1, 3).map(row => row.text)).toEqual(['line 8', 'line 9']);
    expect(rows.slice(3).map(row => row.type)).toEqual(['del', 'ins']);
    // Six unchanged lines stay as they are.
    const short = foldUnchanged(diffLines([...same.slice(0, 6), 'a'], [...same.slice(0, 6), 'b']));
    expect(short.some(row => row.type === 'fold')).toBe(false);
  });
});

describe('warnings', () => {
  test('every code gets a sentence: own codes, generator kinds and unknown codes', () => {
    expect(warningKey({ code: 'NO_CHANGE', field: '' })).toBe(
      'admin.apps.conversation.warning.noChange'
    );
    expect(warningKey({ code: 'KEY_IGNORED', field: 'type' })).toBe(
      'admin.apps.conversation.warning.ignored'
    );
    expect(warningKey({ code: 'FIELD_DROPPED' })).toBe('admin.apps.conversation.warning.dropped');
    expect(warningKey({ code: 'SOMETHING_NEW' })).toBe('admin.apps.conversation.warning.other');
    // A kind is not a code of its own.
    expect(warningKey({ code: 'dropped' })).toBe('admin.apps.conversation.warning.other');
  });
});

describe('error sentences and the stakes line', () => {
  test('errors map by code, the turn limit by limiter, others say the server detail', () => {
    const problem = data => ({ response: { status: 400, data } });
    // Too long: the instructions have their own sentence, every other content key one for all.
    expect(
      reviseErrorMessage(problem({ code: 'APP_REVISE_TOO_LONG', details: { field: 'system' } }))
    ).toEqual({ key: 'admin.apps.conversation.error.tooLong' });
    expect(
      reviseErrorMessage(
        problem({ code: 'APP_REVISE_TOO_LONG', details: { field: 'starterPrompts' } })
      )
    ).toEqual({ key: 'admin.apps.conversation.error.contentTooLong' });
    expect(reviseErrorMessage(problem({ code: 'APP_REVISE_TOO_LONG' }))).toEqual({
      key: 'admin.apps.conversation.error.contentTooLong'
    });
    expect(
      reviseErrorMessage(problem({ code: 'RATE_LIMITED', details: { limiter: 'appRevise' } }))
    ).toEqual({ key: 'admin.apps.conversation.error.tooManyTurns' });
    expect(reviseErrorMessage(problem({ code: 'RATE_LIMITED' }))).toEqual({
      key: 'admin.apps.conversation.error.busy'
    });
    expect(
      reviseErrorMessage(
        problem({ code: 'APP_GENERATOR_INVALID_ANSWER', details: { reason: 'truncated' } })
      )
    ).toEqual({ key: 'admin.apps.conversation.error.truncated' });
    expect(
      reviseErrorMessage(
        problem({ code: 'APP_GENERATOR_INVALID_ANSWER', details: { reason: 'not-json' } })
      )
    ).toEqual({ key: 'admin.apps.conversation.error.unreadable' });
    expect(reviseErrorMessage(problem({ code: 'ABORTED' }))).toBeNull();
    expect(reviseErrorMessage({ code: 'ERR_CANCELED', name: 'CanceledError' })).toBeNull();
    expect(reviseErrorMessage(problem({ code: 'SOMETHING', detail: 'Server says no.' }))).toEqual({
      key: 'admin.apps.conversation.error.failed',
      values: { detail: 'Server says no.' }
    });
  });

  test('the stakes line names who gets the change', () => {
    expect(adminStakes({ published: false })).toEqual([
      { key: 'admin.apps.conversation.stakes.notPublished' }
    ]);
    expect(
      adminStakes({
        published: true,
        accessView: {
          scope: 'all',
          audience: { allSignedIn: false, anonymous: false },
          groups: [{ id: 'hr', name: 'HR', effective: true }]
        },
        integrationNames: ['jira']
      })
    ).toEqual([
      { key: 'admin.apps.conversation.stakes.publishedGroups', values: { groups: 'HR' } },
      { key: 'admin.apps.conversation.stakes.integrations', values: { names: 'jira' } }
    ]);
    expect(personalStakes({ sharedWith: { users: 2, groups: 1 } })).toEqual([
      { key: 'admin.apps.conversation.stakes.shared', values: { count: 3 } }
    ]);
    expect(personalStakes({ sharedWith: { users: 0, groups: 0 } })).toEqual([
      { key: 'admin.apps.conversation.stakes.onlyYou' }
    ]);
  });
});
