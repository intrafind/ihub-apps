# LLM stream timeouts in the admin UI

Issue: intrafind/ihub-apps#3218

## Problem

`streamIdleTimeoutMs` (longest gap between two chunks of a live stream, 60 s) and `connectTimeoutMs`
(longest wait for the response headers, 30 s) can be set per model only. The installation value
(`llm.*` in `platform.json`) has no UI, and there is no level in between. A Gemini thinking model that
stays silent for 60 s was fixed by editing `platform.json` and restarting a pod, or by touching every
model.

## Decisions

### 1. One resolution order, most specific first

```
model  →  provider  →  platform.json `llm`  →  env (LLM_*_TIMEOUT_MS)  →  built-in default
```

- Each level is a number of milliseconds, 0–300000. `0` disables the ceiling (the call is left to
  the whole-call deadline). Empty / absent means "ask the next level".
- The provider level is the provider entry a model takes its key from (`model.providerId`, else
  `model.provider`), so every Google model shares one ceiling and a custom gateway gets its own.
- The embedding seam (`new LLMClient({ streamIdleTimeoutMs })`) keeps its place directly above
  `platform.json`: model → provider → constructor → platform → env.

### 2. Global values: a card on **Admin → Providers**

Providers is where the per-provider override lives, so the whole chain is visible on one page.

```
┌ Admin → Providers ────────────────────────────────────────────────────┐
│ Providers                                          [Test all]  [+ New] │
│                                                                        │
│ ┌ Timeouts for all providers ──────────────────────────────────────┐  │
│ │ Applies to every model unless its provider or the model sets its │  │
│ │ own. Takes effect on the next request — no restart.              │  │
│ │                                                                  │  │
│ │ Connect timeout (ms)        Stream idle timeout (ms)             │  │
│ │ [ 30000        ]            [ 60000        ]                     │  │
│ │ Longest wait for the        Longest silence between two chunks   │  │
│ │ response headers.           of a running stream. 0 = off.        │  │
│ │                                                  [Reset] [Save]  │  │
│ └──────────────────────────────────────────────────────────────────┘  │
│  … provider list …                                                     │
└────────────────────────────────────────────────────────────────────────┘
```

- Empty field = remove the value from `platform.json` and fall back to `LLM_*_TIMEOUT_MS` / the
  built-in default; the placeholder shows that value.
- Own endpoint (`GET/PUT /api/admin/llm-timeouts`) instead of the full `POST /admin/configs/platform`:
  the page does not hold the whole file, and a read-modify-write of it would race other editors.
- Applies live: `LLMClient` reads the platform config on every call.

### 3. Per-provider override: a section on the provider edit page

```
┌ Configure Provider: Google ───────────────────────────────────────────┐
│  Name / ID / Description / API type / Base URL / API key …             │
│                                                                        │
│  Timeouts                                                              │
│  Leave a field empty to use the installation value. Models can still   │
│  set their own.                                                        │
│  Connect timeout (ms)          Stream idle timeout (ms)                │
│  [            ]                [ 180000      ]                         │
│  Inherited: 30000 (installation)  Own value: applies to 4 models       │
│                                                                        │
│                                              [Cancel]  [Save Changes]  │
└────────────────────────────────────────────────────────────────────────┘
```

- Only LLM providers (built-in and custom) show it; web-search and other categories have no models.
- The placeholder is the value the provider would inherit; the hint names where it comes from.
- The model editor gets one line under its two fields: "Empty: the provider's value, else the
  installation's."

### 4. Storage and API

- `providers.json` entries gain optional `connectTimeoutMs` / `streamIdleTimeoutMs` (integers, 0–300000;
  `null`/empty removes the key). Validated in `normalizeProviderFields` with the same bounds as the model
  schema. No defaults are added, so **no config migration**.
- `GET /api/admin/llm-timeouts` → `{ saved, effective, defaults }`; `PUT` with `{ connectTimeoutMs?, streamIdleTimeoutMs? }`
  (integer, or `null` to clear), `400 VALIDATION_FAILED` otherwise. Audit entry on save.

### 5. Error text

The connect-timeout error names every place the value can be raised: `platform.json`, the model and its provider. The stream-idle error is unchanged.

### Not in this change

`thinking.level` on Gemini models (named as out of scope in the issue).
