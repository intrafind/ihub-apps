import en from '../../../shared/i18n/en.json';
import de from '../../../shared/i18n/de.json';

/**
 * Every string of the memory feature on the task pages exists in both
 * languages, with the same placeholders. The client falls back to English for
 * a missing German key without a word, so nothing else would notice.
 */

const KEYS = [
  'scheduledTasks.notify.changes',
  'scheduledTasks.memory.title',
  'scheduledTasks.memory.label',
  'scheduledTasks.memory.help',
  'scheduledTasks.memory.platformOff',
  'scheduledTasks.memory.notifyNeedsMemory',
  'scheduledTasks.memory.on',
  'scheduledTasks.memory.off',
  'scheduledTasks.memory.cardIntro',
  'scheduledTasks.memory.offNotice',
  'scheduledTasks.memory.platformOffNotice',
  'scheduledTasks.memory.readOnlyNotice',
  'scheduledTasks.memory.clearHint',
  'scheduledTasks.memory.tooLong',
  'scheduledTasks.memory.error',
  'scheduledTasks.runs.noChanges',
  'scheduledTasks.runs.memoryUpdated',
  'scheduledTasks.runs.memoryTooLong',
  'scheduledTasks.runs.memoryTooLongHint',
  'scheduledTasks.runs.memoryFailed',
  'scheduledTasks.runs.memoryFailedHint',
  'scheduledTasks.variablesHelpText',
  'admin.scheduledTasks.columns.memory',
  'admin.scheduledTasks.memory.summary',
  'admin.scheduledTasks.memory.clear',
  'admin.scheduledTasks.memory.confirmClear',
  'admin.scheduledTasks.memoryEnabledHint',
  'admin.scheduledTasks.settings.memoryEnabled',
  'admin.scheduledTasks.settings.memoryMaxChars',
  'admin.scheduledTasks.settings.maxHistoryReadChars'
];

const lookup = (messages, key) => key.split('.').reduce((node, part) => node?.[part], messages);
const placeholders = text => [...text.matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1]).sort();

describe('scheduled task memory strings', () => {
  it.each(KEYS)('%s is translated into English and German', key => {
    const english = lookup(en, key);
    const german = lookup(de, key);
    expect(typeof english).toBe('string');
    expect(english).not.toBe('');
    expect(typeof german).toBe('string');
    expect(german).not.toBe('');
    expect(german).not.toBe(english);
    expect(placeholders(german)).toEqual(placeholders(english));
  });

  it('names the setting the same in the form, its help and the reworded variables hint', () => {
    expect(lookup(en, 'scheduledTasks.variablesHelpText')).toContain(
      lookup(en, 'scheduledTasks.memory.label')
    );
    expect(lookup(de, 'scheduledTasks.variablesHelpText')).toContain(
      lookup(de, 'scheduledTasks.memory.label')
    );
    expect(lookup(en, 'scheduledTasks.memory.notifyNeedsMemory')).toContain(
      lookup(en, 'scheduledTasks.memory.label')
    );
    expect(lookup(de, 'scheduledTasks.memory.notifyNeedsMemory')).toContain(
      lookup(de, 'scheduledTasks.memory.label')
    );
  });
});
