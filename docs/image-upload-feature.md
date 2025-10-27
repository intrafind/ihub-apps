# Image Upload Feature Documentation

## Overview

The image upload feature allows users to attach images to their chat messages. Images can optionally be resized on the client before being sent to the AI service.

## Configuration

Enable the feature in an app by adding an `imageUpload` object with an `enabled` flag and optional settings:

```json
"upload": {
  "enabled": true,
  "allowMultiple": false
},
"imageUpload": {
  "enabled": true,
  "resizeImages": true
}
```

### Configuration Options

**upload.allowMultiple** (boolean)

- When `true`, allows users to select and upload multiple files/images at once
- Default: `false`
- All selected images will be processed individually and sent with the message
- This setting applies to both image and file uploads

**imageUpload.resizeImages** (boolean)

- When `true` (default) the uploaded image is resized to a maximum dimension of 1024 px and converted to JPEG before being sent.
- Set to `false` to use the original image without resizing or format conversion.

## Usage

When enabled a camera icon appears next to the chat input. Clicking it lets the user select an image which will be previewed before sending.

## Extended Usage

When multiple upload is enabled (`upload.allowMultiple: true`), users can select multiple images at once from the file picker. Each image will be individually validated, processed, and displayed in a preview before sending.
