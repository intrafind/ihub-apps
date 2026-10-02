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

## Apps: Links Must Use http or https, and Invalid App Configurations Are Not Saved

Redirect apps open, and iframe apps embed, only addresses that start with `http://` or
`https://`. A redirect or iframe app with any other kind of link (for example `mailto:`) shows an
error instead of opening or embedding it.

Creating or saving an app — under **Admin → Apps**, with the app creation wizard, by uploading an
app file or through the admin API — now checks the complete configuration against the app schema.
A configuration that does not pass is not saved, and the admin sees a validation error naming the
field, for example:

> Invalid app configuration: redirectConfig.url: Redirect URL must use http or https

- App files already on the server keep loading as before. One that does not pass is reported in
  the server log ("Resource validation issues") and has to be corrected before it can be saved
  again.
- Apps created with the app creation wizard in earlier releases contained the fields `useAI`,
  `useTemplate`, `useManual`, `aiGenerated`, `aiPrompt`, a top-level `imageUpload` and
  `"parentId": null`. They have no effect, and the upgrade removes them from the app files on the
  server, so these apps can be saved as before.

**Before upgrading:** Change redirect and iframe apps whose URL does not start with `http://` or
`https://`. App files uploaded under **Admin → Apps** and scripts that create or update apps
through the admin API must send configurations that pass validation; fields that are not part of
an app configuration are rejected.
