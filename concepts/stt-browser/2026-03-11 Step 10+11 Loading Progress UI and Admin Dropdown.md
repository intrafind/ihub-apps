# Step 10+11: Loading Progress UI and Admin Dropdown

**Date:** 2026-03-11
**Feature:** In-Browser Speech-to-Text (STT)
**Tasks:** 10a, 10b, 11

---

## What Was Done

### Task 10a — VoiceInputComponent.jsx

`useVoiceRecognition` already exported `isModelLoading` and `loadingProgress` (confirmed in the hook's return statement). The component was updated to:

1. Destructure `isModelLoading` and `loadingProgress` from the hook call.
2. Forward both props to `<VoiceFeedback>`.

**File:** `client/src/features/voice/components/VoiceInputComponent.jsx`

---

### Task 10b — VoiceFeedback.jsx

The component already used `useTranslation` internally, so `t` was available without any prop changes.

Two additions were made:

1. `isModelLoading` and `loadingProgress` added to the props destructuring (with safe defaults: `false` and `0`).
2. A conditional progress bar block inserted above the transcript display. The bar uses Tailwind utility classes and grows from a minimum of 2% (so it is always visible when loading starts) to 100%.

**File:** `client/src/features/voice/components/VoiceFeedback.jsx`

i18n key added: `voiceInput.loadingModel` — "Loading speech model..."

---

### Task 11 — AppFormEditor.jsx (Admin Speech Recognition Dropdown)

Three changes were made to the speech recognition section (~line 1754):

1. **Dropdown options** — replaced the old `default` + `custom` pair with five options:
   - `default` — "Default (Browser)"
   - `azure` — "Azure Speech Services"
   - `whisper` — "Whisper (Local, Multilingual)"
   - `parakeet` — "Parakeet (Local, English)"
   - `moonshine` — "Moonshine (Local, Lightweight)"

2. **Azure host field condition** — changed `=== 'custom'` to `=== 'azure'`, and updated the label key from `customServiceHost` to `azureServiceHost` / "Azure Service Host".

3. **Whisper model selector** — added a new `<select>` that appears when `service === 'whisper'`, offering:
   - `whisper-tiny` — Whisper Tiny (~75MB, multilingual)
   - `whisper-base` — Whisper Base (~150MB, multilingual)

   The onChange handler follows the same spread pattern used throughout AppFormEditor for nested `settings.speechRecognition.*` fields.

**File:** `client/src/features/admin/components/AppFormEditor.jsx`

i18n keys added:
- `admin.apps.edit.azureService`
- `admin.apps.edit.whisperService`
- `admin.apps.edit.parakeetService`
- `admin.apps.edit.moonshineService`
- `admin.apps.edit.azureServiceHost`
- `admin.apps.edit.whisperModel`

---

## Continuing This Work

A junior developer picking this up should:

1. Add the new i18n keys listed above to all language files under `client/src/locales/` (or wherever translations are maintained).
2. Verify in the browser: start a voice session using each of the three local STT services and confirm the progress bar appears and fills to 100% before listening begins.
3. In the admin panel, confirm that selecting "Azure Speech Services" shows the host URL field, selecting "Whisper" shows the model picker, and all other services show no extra fields.
4. Consider adding a similar model picker for Moonshine once multiple Moonshine model sizes are available.

---

## Lint Status

After all changes: `0 errors, 98 warnings` (warnings are pre-existing in unrelated test files, none introduced by these changes).
