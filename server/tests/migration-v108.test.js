#!/usr/bin/env node

/**
 * Migration V108 specs — the meeting apps' prompts follow the Outlook add-in
 * from the "--- Current meeting ---" heading to the <current_meeting> block.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { up, precondition, version } from '../migrations/V108__office_context_xml_tags.js';

function fakeCtx(files) {
  const logs = [];
  const writes = [];
  return {
    files,
    logs,
    writes,
    fileExists: async p => p in files,
    readJson: async p => JSON.parse(JSON.stringify(files[p])),
    writeJson: async (p, d) => {
      files[p] = d;
      writes.push(p);
    },
    log: m => logs.push(m),
    warn: m => logs.push(m)
  };
}

const shippedBriefing = () => ({
  id: 'meeting-briefing',
  system: {
    en: "You'll receive the invite metadata (subject, time) in a section labeled '--- Current meeting ---' inside the user message, plus access to the knowledge base.",
    de: "Du erhältst die Einladungs-Metadaten in einem Abschnitt mit der Überschrift '--- Current meeting ---' in der Nutzernachricht, sowie Zugriff auf die Wissensdatenbank."
  },
  preferredOutputFormat: 'markdown'
});

const shippedAgenda = () => ({
  id: 'meeting-agenda-generator',
  system: {
    en: "you'll receive the invite metadata in a section labeled '--- Current meeting ---' inside the user message. You also have access to the knowledge base.",
    de: "du erhältst die Einladungs-Metadaten in einem Abschnitt mit der Überschrift '--- Current meeting ---' innerhalb der Nutzernachricht. Außerdem hast du Zugriff auf die Wissensdatenbank."
  }
});

test('version is the next unused number', () => {
  assert.equal(version, '108');
});

test('precondition is false when neither meeting app exists', async () => {
  assert.equal(await precondition(fakeCtx({})), false);
  assert.equal(
    await precondition(fakeCtx({ 'apps/meeting-agenda-generator.json': shippedAgenda() })),
    true
  );
});

test('both shipped prompts are pointed at the tagged blocks in every language', async () => {
  const ctx = fakeCtx({
    'apps/meeting-briefing.json': shippedBriefing(),
    'apps/meeting-agenda-generator.json': shippedAgenda()
  });

  await up(ctx);

  const briefing = ctx.files['apps/meeting-briefing.json'];
  assert.match(briefing.system.en, /inside a <current_meeting> block in the user message/);
  assert.match(briefing.system.en, /<user_instruction> block/);
  assert.match(briefing.system.de, /in einem <current_meeting>-Block in der Nutzernachricht/);
  assert.doesNotMatch(briefing.system.en, /--- Current meeting ---/);
  assert.doesNotMatch(briefing.system.de, /--- Current meeting ---/);
  // Everything around the heading is untouched.
  assert.match(briefing.system.en, /plus access to the knowledge base\.$/);
  assert.equal(briefing.preferredOutputFormat, 'markdown');

  const agenda = ctx.files['apps/meeting-agenda-generator.json'];
  assert.match(agenda.system.en, /in a <user_instruction> block\. You also have access/);
  assert.match(agenda.system.de, /<current_meeting>-Block innerhalb der Nutzernachricht/);
  assert.doesNotMatch(agenda.system.de, /--- Current meeting ---/);

  assert.deepEqual(ctx.writes.sort(), [
    'apps/meeting-agenda-generator.json',
    'apps/meeting-briefing.json'
  ]);
  assert.equal(ctx.logs.length, 2);
});

test('a prompt an admin rewrote is left alone and not rewritten', async () => {
  const custom = {
    id: 'meeting-briefing',
    system: { en: 'Prepare me for the meeting described below.', de: 'Bereite mich vor.' }
  };
  const ctx = fakeCtx({ 'apps/meeting-briefing.json': custom });

  await up(ctx);

  assert.deepEqual(ctx.files['apps/meeting-briefing.json'], custom);
  assert.deepEqual(ctx.writes, []);
});

test('a missing app file or a non-object system prompt is skipped', async () => {
  const ctx = fakeCtx({
    'apps/meeting-agenda-generator.json': { id: 'meeting-agenda-generator', system: 'plain string' }
  });

  await up(ctx);

  assert.deepEqual(ctx.writes, []);
  assert.equal(ctx.files['apps/meeting-agenda-generator.json'].system, 'plain string');
});
