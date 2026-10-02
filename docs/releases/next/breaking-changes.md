# Breaking Changes — Unreleased

## Voice Input: The vLLM Realtime Setting Moved to a Transcription Model

Voice input now uses transcription models (see the feature entry), so the separate **vLLM
Realtime** section in **Admin → Voice Input** and the `vllm-realtime` speech recognition service
are gone. The upgrade moves an existing setup over automatically:

- The endpoint, model and key from `speech.realtime` move onto the `voxtral-mini-realtime` model
  when it points at the same endpoint, or onto a new `voxtral-mini-realtime-dictation` model when
  it does not. The model is enabled if the endpoint was.
- The platform default and every app that used `vllm-realtime` switch to that model.
- Groups that could dictate before get access to the model, since a model needs a permission
  that the old setting did not.
- `speech.realtime` keeps only its connection limits (`maxConnections` and the others).
- `POST /api/admin/voice/realtime/test` is removed. Use the **Test** action on the model in
  **Admin → Models**.

**Before upgrading:** Scripts or config management that write `speech.realtime.url`, `model`,
`apiKey` or `enabled`, or set `speechRecognition.service` to `vllm-realtime`, must set the
endpoint on the model instead and use `"service": "model"` with a `modelId`. After the upgrade,
check **Admin → Voice Input** and the groups' model permissions.
