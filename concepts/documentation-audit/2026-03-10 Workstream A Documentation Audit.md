# Workstream A — Documentation Audit

**Date:** 2026-03-10
**Author:** Claude Sonnet 4.6 (automated)
**Scope:** Three documentation files updated to match validator schemas and default config

---

## What Was Done

This workstream audited and updated three documentation files so they accurately reflect
the actual server-side validator schemas (`server/validators/*.js`) and the default
platform configuration (`server/defaults/config/platform.json`).

---

## A1 — `docs/apps.md`

### Source of truth used
- `server/validators/appConfigSchema.js`

### Changes made

1. **Property Details table expanded** — All required/optional columns now show correct
   cardinality. Added 15+ previously undocumented fields:

   | Field | Notes |
   |---|---|
   | `type` | Added to the table (was only in the App Types section) |
   | `enabled`, `category` | Added (were in CLAUDE.md schema reference but missing from docs table) |
   | `autoStart` | New — boolean, default `false`, auto-sends prompt on open |
   | `customResponseRenderer` | New — custom response component name |
   | `skills` | New — array of skill ID strings |
   | `skillSettings` | New — `autoActivate` + `maxActiveSkills` object |
   | `iassistant` | New — app-specific iAssistant override config |
   | `imageGeneration` | New — `aspectRatio` + `quality` defaults |
   | `thinking` | New — `enabled`, `budget`, `thoughts` |
   | `allowInheritance`, `parentId`, `inheritanceLevel`, `overriddenFields` | New inheritance fields |

2. **Settings Configuration section enhanced** with new fields:
   - `settings.model.filter` — record to filter available models by property
   - `settings.imageGeneration.enabled` — show/hide image generation panel
   - `settings.speechRecognition.service` / `.host` — speech recognition config

3. **Starter Prompts section expanded** with a full field table documenting:
   - `description` (localizedString, optional)
   - `autoSend` (boolean, default `false`)

4. **New subsections added after "Other Options":**
   - **Upload Configuration** — full table covering `allowMultiple`, `audioUpload.*`, `cloudStorageUpload.*`
   - **Skill Settings** — `skills[]` array and `skillSettings` object
   - **iAssistant Configuration** — full filter schema with `isNegated`
   - **Image Generation Configuration** — aspectRatio + quality
   - **Thinking Configuration** — enabled, budget, thoughts

---

## A2 — `docs/models.md`

### Source of truth used
- `server/validators/modelConfigSchema.js`

### Changes made

1. **Property Details table completely replaced** — Added columns for Type / Default.
   Added 11 previously undocumented fields:

   | Field | Notes |
   |---|---|
   | `default` | Boolean — system-wide default flag |
   | `enabled` | Boolean, default `true` |
   | `description` | Required localizedString (was missing from table) |
   | `supportsImages` | Boolean — deprecated alias for `supportsVision` |
   | `supportsVision` | Boolean — image input support |
   | `supportsAudio` | Boolean — audio input support |
   | `supportsStructuredOutput` | Boolean — native JSON schema output |
   | `supportsUsageTracking` | Boolean — usage reporting |
   | `supportsImageGeneration` | Boolean, default `false` |
   | `imageGeneration` | Object — see new subsection |
   | `apiKey` | Per-model encrypted API key |
   | `config` | Provider-specific pass-through config record |
   | `concurrency` | Int 1-100 — max concurrent requests |
   | `thinking` | Object — see new subsection |

2. **Provider list updated** — Added entry 7: `iassistant-conversation`

3. **New subsections added** (before "Model Selection in Apps"):
   - **Image Generation Defaults** — `aspectRatio`, `quality`, `maxReferenceImages` with defaults
   - **Model Thinking Configuration** — `enabled`, `budget` (with -1/0/positive semantics), `thoughts`

---

## A3 — `docs/platform.md`

### Source files used
- `server/validators/platformConfigSchema.js`
- `server/validators/cloudStorageSchema.js`
- `server/defaults/config/platform.json`

### Changes made

1. **`auth.mode` description fixed** — Now lists all 6 valid values:
   `proxy`, `local`, `oidc`, `ldap`, `ntlm`, `anonymous`

2. **New section: `ldapAuth`** — Full provider schema table including:
   - `url`, `adminDn`, `adminPassword`, `userSearchBase`, `usernameAttribute`
   - `userDn`, `groupSearchBase`, `groupClass`, `groupMemberAttribute`, `groupMemberUserAttribute`
   - `defaultGroups`, `sessionTimeoutMinutes`, `tlsOptions`

3. **New section: `ntlmAuth`** — Full schema table including:
   - `domain`, `domainController`, `type` (ntlm/negotiate), `debug`
   - `getUserInfo`, `getGroups`, `domainControllerUser`, `domainControllerPassword`
   - `defaultGroups`, `sessionTimeoutMinutes`, `generateJwtToken`, `options`

4. **New section: Rate Limiting** — All 6 limiter categories with defaults table

5. **New section: SSL Configuration** — `ignoreInvalidCertificates` + `domainWhitelist`

6. **New section: Logging** — `level`, `format`, `file.enabled/path/maxSize/maxFiles`

7. **New section: JWT Configuration** — `algorithm` (default RS256)

8. **New section: iFinder Integration** — All 8 fields from `server/defaults/config/platform.json`

9. **New section: iAssistant Integration** — `baseUrl`, `defaultProfileId`, `timeout`

10. **New section: OAuth Server Configuration** — All 11 oauth fields from default config

11. **New section: Cloud Storage Configuration** — Full schema for:
    - Top-level: `enabled`, `providers[]`
    - Office 365 provider: all fields including `sources.*`
    - Google Drive provider: all fields including `sources.*`

12. **New section: Skills Configuration** — `skillsDirectory`, `maxSkillBodyTokens`

---

## How to Continue This Work

If a junior developer needs to extend this audit:

1. **Check new validators** in `server/validators/` — If a new `*Schema.js` file appears,
   check whether the corresponding doc in `docs/` covers all its fields.

2. **Run the diff** — Compare `Object.keys(schema.shape)` against the property table in
   the corresponding doc to find missing fields quickly.

3. **Always use the schema as ground truth**, not the default config — the schema defines
   what is *valid*, while the default config shows what is *shipped by default*.

4. **For platform.json additions** — Also check `server/migrations/` to see if a migration
   was written that adds new config keys; those fields should be documented too.

5. **Do not lint/format** — The CI pipeline handles formatting automatically.

---

## Files Modified

- `/Users/danielmanzke/Workspaces/github.intrafind/ihub-apps/docs/apps.md`
- `/Users/danielmanzke/Workspaces/github.intrafind/ihub-apps/docs/models.md`
- `/Users/danielmanzke/Workspaces/github.intrafind/ihub-apps/docs/platform.md`
