// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V241 — AI disclosure settings (#3325, EU AI Act Art. 50(1))
 *
 * The empty chat shows a short notice that the user is talking to an AI system.
 * It is on by default; this writes the setting's defaults into `platform.json`
 * so the admin sees them:
 * - `aiDisclosure.firstTurnNotice.enabled` — true (master switch);
 * - `aiDisclosure.firstTurnNotice.text` — `{}`, which means the built-in text;
 * - `aiDisclosure.guardrail.text` — empty, which means the built-in guardrail rule
 *   (the rule can be reworded, never switched off).
 *
 * Existing values are kept.
 */

export const version = '241';
export const description = 'ai_disclosure_first_turn_notice';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  ctx.setDefault(platform, 'aiDisclosure.firstTurnNotice.enabled', true);
  ctx.setDefault(platform, 'aiDisclosure.firstTurnNotice.text', {});
  ctx.setDefault(platform, 'aiDisclosure.guardrail.text', '');
  await ctx.writeJson('config/platform.json', platform);
  ctx.log('AI first-turn notice is on (aiDisclosure.firstTurnNotice.enabled = true)');
}
