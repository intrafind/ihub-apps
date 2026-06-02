/**
 * Migration V043 — Fix iFinder.jwtSubjectField template syntax
 *
 * Background: the JWT subject template in `iFinder.jwtSubjectField` used the
 * `${field}` placeholder syntax (e.g. `"BMG\\${username}"`). configCache's
 * env var resolver matched the same pattern and would replace `${username}`
 * with `process.env.username` at config-load time. On Windows that env var
 * is automatically set to the OS user running the server (typically a
 * service account like `svc_ifinder-indexer`), which silently leaked that
 * account into every iFinder JWT subject — every user appeared to iFinder as
 * the service account.
 *
 * Fix: switch to explicit `${user.field}` syntax. The dot makes the
 * placeholder name invalid as an env var identifier (regex
 * `[A-Za-z_][A-Za-z0-9_]*`), so the env var resolver no longer matches it.
 * configCache also now skips env var resolution for this path entirely
 * (ENV_VAR_RESOLUTION_SKIP_PATHS), but the explicit `user.` prefix keeps the
 * intent clear in the config.
 *
 * Standard values (`email`, `username`, `domain\\username`) are unchanged —
 * they are looked up by `iFinderJwt.resolveJwtSubject`, not template-replaced.
 */

export const version = '043';
export const description = 'fix_ifinder_jwt_subject_template';

const STANDARD_VALUES = new Set(['email', 'username', 'domain\\username']);

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  const current = platform?.iFinder?.jwtSubjectField;
  if (typeof current !== 'string') {
    ctx.log('No iFinder.jwtSubjectField set; nothing to migrate');
    return;
  }

  if (STANDARD_VALUES.has(current)) {
    ctx.log(`iFinder.jwtSubjectField is a standard value ("${current}"); leaving unchanged`);
    return;
  }

  // Rewrite legacy ${field} -> ${user.field}. Skip placeholders already in the
  // new ${user.field} form.
  const updated = current.replace(/\$\{(?!user\.)(\w+)\}/g, '${user.$1}');

  if (updated === current) {
    ctx.log(`iFinder.jwtSubjectField "${current}" already uses safe syntax; no change needed`);
    return;
  }

  platform.iFinder.jwtSubjectField = updated;
  await ctx.writeJson('config/platform.json', platform);

  ctx.warn(
    `Rewrote iFinder.jwtSubjectField from "${current}" to "${updated}". ` +
      'The legacy ${field} syntax collided with env var resolution and could ' +
      'leak the OS service account (Windows process.env.username) into every ' +
      'iFinder JWT subject. Review your iFinder audit logs for the affected ' +
      'time window if applicable.'
  );
}
