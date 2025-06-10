# Microphone Feature Documentation

## Overview

The microphone feature allows users to dictate messages instead of typing.
It supports two operation modes and an optional transcript overlay.

## Modes

- `automatic` - Speech recognition stops automatically when the user pauses.
- `manual` - Recognition continues until the user stops it manually.

## Transcript Overlay

Set `showTranscript` to `true` to display the live transcript during recording.

## Example Configuration

```json
"microphone": {
  "enabled": true,
  "mode": "automatic",
  "showTranscript": true
}
```
