# Fixes — 5.4.25

## Voice Input: Azure Speech Works With On-Prem Containers Again

Voice input with the Azure service failed with "Azure subscription key is not configured" when
it pointed at an on-prem Azure Speech container, which has no key. Leave the subscription key
empty under **Admin → Voice Input** and set the host to the container, or keep the host an app
already sets: the browser now connects to it directly, with no call to Microsoft from the browser
or the iHub server, so this works fully air-gapped. Azure cloud still needs a key. A failed Azure
setup now shows its error instead of a generic "Error starting voice input".

## Azure Speech Dictation Works Again

Dictation with Azure Speech put no text into the chat input. The subscription key set under
**Admin → Voice Input** was also never used: an app without a host of its own failed with "Azure
subscription key is not configured".

- The recognized text is delivered to the input again, in both manual and automatic mode.
- The subscription key stored on the server is used (as a short-lived token), and apps without
  a host of their own fall back to the host set under **Admin → Voice Input**, as documented.
- A "no speech detected" error no longer leaves the microphone in the listening state.
- Stopping dictation in automatic mode releases the microphone right away instead of waiting for
  Azure to finish.
