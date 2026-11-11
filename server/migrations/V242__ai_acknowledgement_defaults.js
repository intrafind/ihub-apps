// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V242 — AI-use acknowledgement defaults (#3326, EU AI Act)
 *
 * Writes the `aiAcknowledgement` block into `platform.json` so the admin sees it:
 * on by default, enforced, version 1, with a short neutral text in English and
 * German. Values the admin already set are kept (`setDefault` semantics).
 *
 * Behaviour change: with enforcement on, every user, anonymous visitors
 * included, is asked to confirm once before the next chat message.
 */

export const version = '242';
export const description = 'ai_acknowledgement_defaults';

const DEFAULT_TEXT = {
  en: "This platform uses AI systems. Their answers can be incorrect or incomplete. Please use them responsibly and follow your organisation's AI policy.",
  de: 'Diese Plattform nutzt KI-Systeme. Deren Antworten können falsch oder unvollständig sein. Bitte nutzen Sie sie verantwortungsvoll und beachten Sie die KI-Richtlinie Ihrer Organisation.'
};

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  ctx.setDefault(platform, 'aiAcknowledgement.enabled', true);
  ctx.setDefault(platform, 'aiAcknowledgement.enforce', true);
  ctx.setDefault(platform, 'aiAcknowledgement.requiredVersion', 1);
  ctx.setDefault(platform, 'aiAcknowledgement.resetAt', null);
  ctx.setDefault(platform, 'aiAcknowledgement.text.en', DEFAULT_TEXT.en);
  ctx.setDefault(platform, 'aiAcknowledgement.text.de', DEFAULT_TEXT.de);
  ctx.setDefault(platform, 'aiAcknowledgement.policyUrl', '');
  await ctx.writeJson('config/platform.json', platform);
  ctx.log('AI-use acknowledgement defaults written (enabled, enforced, version 1)');
}
