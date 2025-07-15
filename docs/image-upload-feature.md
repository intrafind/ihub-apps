# Image Upload Feature Documentation

## Overview

The image upload feature allows users to attach images to their chat messages. Images can optionally be resized on the client before being sent to the AI service.

## Configuration

Enable the feature in an app by adding an `imageUpload` object with an `enabled` flag and optional `resizeImages` setting:

```json
"imageUpload": {
  "enabled": true,
  "resizeImages": true
}
```

### Configuration Options

**imageUpload.resizeImages** (boolean)

- When `true` (default) the uploaded image is resized to a maximum dimension of 1024 px and converted to JPEG before being sent.
- Set to `false` to use the original image without resizing or format conversion.

## Usage

When enabled a camera icon appears next to the chat input. Clicking it lets the user select an image which will be previewed before sending.
