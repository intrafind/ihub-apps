# useVoiceRecognition Hook — Browser STT Integration

**Date:** 2026-03-11
**Author:** Claude Code (automated implementation)
**Status:** Implemented

---

## What was changed and why

The `useVoiceRecognition` hook previously only supported two speech recognition backends:

- `'default'` — the browser's native Web Speech API (`window.SpeechRecognition`)
- `'azure'` — the Azure Cognitive Services adapter (`AzureSpeechRecognition`)

This step wires in the three new in-browser ML adapters so they can be selected via app-level or platform-level configuration:

| Service key  | Class                | Model selection                  |
|--------------|----------------------|----------------------------------|
| `'whisper'`  | `WhisperRecognition` | configurable via `modelId`        |
| `'parakeet'` | `ParakeetRecognition`| fixed (`parakeet-tdt-0.6b`)      |
| `'moonshine'`| `MoonshineRecognition`| configurable via `modelId`      |

---

## Service resolution order

When `startListening()` is called the hook picks the active backend by checking in this order:

1. `app.settings.speechRecognition.service` — per-app override in the app JSON config
2. `platformConfig.speechRecognition.defaultService` — global platform default
3. `'default'` — falls back to the browser's native Web Speech API

The same three-level cascade applies to `modelId` (default: `'whisper-tiny'`) and `modelsBasePath` (default: `'/api/stt-models'`).

---

## New state exposed by the hook

Two additional values are returned from the hook to let callers display a loading indicator while the ONNX model is downloaded on first use:

| Name             | Type      | Description                                         |
|------------------|-----------|-----------------------------------------------------|
| `isModelLoading` | `boolean` | `true` while `recognition.init()` is awaiting      |
| `loadingProgress`| `number`  | 0-100 integer forwarded from the model loader       |

`isModelLoading` is set to `false` again immediately after `init()` resolves, and also inside the top-level `catch` block so it is never left stuck at `true` if init throws.

---

## Web Speech API guard

The browser-native (`'default'`) and `'azure'` services require `window.SpeechRecognition` or `window.webkitSpeechRecognition` to exist.  The in-browser ML services manage their own audio pipeline and do **not** require the Web Speech API.

The guard condition was therefore changed from an unconditional early return to:

```js
const isBrowserMLService =
  service === 'whisper' || service === 'parakeet' || service === 'moonshine';

if (!isBrowserMLService && !('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
  showError(t('voiceInput.error.notSupported', ...));
  return;
}
```

---

## Model caching and the loading flag

`sttModelLoader.js` caches loaded models in a module-level `Map` keyed by `"service:modelId"`.  The hook uses `isModelCached()` to check whether a download is needed before calling `init()`.  This means `isModelLoading` is only set to `true` on the very first use — subsequent calls within the same page session skip the flag entirely.

---

## Callback compatibility

All three new adapters implement the same callback interface as the existing services:

- `onstart()` — fires when recording begins
- `onresult(event)` — fires with `{ results: [[{ transcript, confidence }]] }` shape (identical to the Web Speech API event shape consumed by the existing `recognition.onresult` handler)
- `onerror(event)` — fires with `{ error: string }`
- `onend()` — fires when the session fully closes

The `recognition.continuous`, `recognition.interimResults`, and `recognition.lang` assignments that follow the `switch` block are no-ops for the ML adapters (they simply ignore unknown properties), so no conditional branching was needed there.

---

## Files changed

| File | Change |
|------|--------|
| `client/src/features/voice/hooks/useVoiceRecognition.js` | Added imports, `usePlatformConfig`, `isModelLoading`/`loadingProgress` state, service-resolution logic, three new `switch` cases, updated return object |

---

## How to continue this work (for junior developers)

### If you want to add another STT backend

1. Create `client/src/utils/myNewRecognitionService.js` implementing the five-callback interface (`onstart`, `onresult`, `onerror`, `onend`, `lang`) plus `async init(basePath, onProgress)`, `async start()`, `async stop()`.
2. Add a loader case to `client/src/utils/sttModelLoader.js` inside the `switch (service)` block.
3. Import your new class into `useVoiceRecognition.js` and add a `case 'my-service':` block inside `startListening()`.
4. Update the admin UI dropdown (Step 10 in the task tracker) to include the new option.

### If the loading indicator is not showing

- Check that the parent component reads `isModelLoading` and `loadingProgress` from the hook return value and renders something conditional on them.
- The `loadingProgress` value comes from the model loader's `onProgress` callback.  For Parakeet and Moonshine, the loader only fires `0` at the start and `100` on completion because those libraries do not expose granular progress.  Whisper fires intermediate percentages.

### If models are not found (404 errors)

- `modelsBasePath` resolves to `/api/stt-models` by default.  The Express route that serves model files must be registered in the server (Step 3, already completed).  Verify the model directory exists under `contents/stt-models/`.
- Check `platformConfig.speechRecognition.modelsBasePath` in `contents/config/platform.json` if you need a custom path.
