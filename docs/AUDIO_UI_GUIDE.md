# Audio Upload UI Features - Visual Guide

This document describes the UI changes for audio file upload support.

## 1. Admin Configuration Interface

**Location:** App Editor → Upload Configuration Section

### Audio Upload Settings Panel

Located after the File Upload section, the Audio Upload configuration includes:

```
Upload Configuration
────────────────────────────────────────

☑ Enable Upload
  ☑ Allow Multiple Files
  
  ☑ Enable Image Upload
    Max Image Size (MB): [10]
    ☑ Resize Images
    Supported Formats: ☑ JPEG ☑ PNG ☑ GIF ☑ WebP
  
  ☑ Enable File Upload
    Max File Size (MB): [5]
    Supported Formats: ☑ TXT ☑ MD ☑ CSV ... (16 formats)
  
  ☑ Enable Audio Upload                    ← NEW!
    Max Audio File Size (MB): [20]
    Supported Audio Formats:
      ☑ MP3 (audio/mpeg)
      ☑ MP3 (audio/mp3)
      ☑ WAV
      ☑ FLAC
      ☑ OGG
```

**Features:**
- Toggle to enable/disable audio upload
- Configurable max file size (1-2000MB, default 20MB). Audio files are held to this limit, not to the larger limits of other upload types
- Individual checkboxes for each audio format
- Follows same UI pattern as image/file upload
- Purple/indigo theme matching the admin interface

## 2. Upload Preview (Before Sending)

**Location:** Chat Input Area → After clicking upload button

### Single Audio File Preview

```
┌─────────────────────────────────────┐
│ 🎵  recording.mp3             [×]  │
│     audio/mpeg                      │
└─────────────────────────────────────┘
Audio file selected
```

**Visual Details:**
- Musical note icon (🎵) in purple color
- Filename displayed prominently
- File type shown below filename
- Remove button (×) in top right corner
- Gray background with border
- "Audio file selected" confirmation text

### Multiple Files Preview

When multiple files including audio are selected:

```
┌─────────────────────────────────────┐
│ 🖼️  image.png                        │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│ 🎵  audio1.mp3                      │
│     audio/mpeg                      │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│ 🎵  audio2.wav                      │
│     audio/wav                       │
└─────────────────────────────────────┘

[Remove All]

3 file(s) selected
```

## 3. Chat Message Display

**Location:** Chat History → User and Assistant Messages

Audio you send is shown as a card above your message, not inside its text. There is no audio player
in the message: the server does not keep the audio of a chat message, so a player would work only
until the page is reloaded. The card says what was sent and keeps its look after a reload.

```
                                  ┌───────────────────────────────────────┐
                                  │ [♪]  recording.mp3                    │
                                  │      WAV · 5 KB                       │
                                  │      Audio sent to the model          │
                                  └───────────────────────────────────────┘
                                       ┌─────────────────────────────────┐
                                       │ Transcribe this audio please    │
                                       └─────────────────────────────────┘
```

- The card is a plain card, not a button: there is nothing stored to open.
- After a reload it shows the name, type and size; the line "Audio sent to the model" is shown for a
  message sent in the current session.
- Several audio files are several cards. From the fifth file of a message (the fourth on a phone or
  in the Outlook task pane) the rest fold into **+N more files**.

## 4. Error States

### Unsupported Format

```
┌─────────────────────────────────────┐
│ ⚠️  Error                            │
│ Unsupported file format.            │
│ Please use: MP3, WAV, FLAC, OGG     │
└─────────────────────────────────────┘
```

### File Too Large

```
┌─────────────────────────────────────┐
│ ⚠️  Error                            │
│ File too large.                     │
│ Maximum size is 20MB.               │
└─────────────────────────────────────┘
```

The message names the limit of the file's own type (here the audio limit), not the largest limit of the app.

### Audio Upload Disabled for Model

```
┌─────────────────────────────────────┐
│ ⚠️  Error                            │
│ Audio upload is not supported       │
│ by the selected model.              │
│ Please choose a different model.    │
└─────────────────────────────────────┘
```

## 5. Color Scheme

**Audio Theme:**
- Primary color: Purple/Violet (#8B5CF6 and variants)
- Used to differentiate from:
  - Images: Blue theme
  - Documents: Gray theme
  - System messages: Yellow/Green themes

**Rationale:**
- Purple is commonly associated with audio/music (Spotify, Apple Music use purple)
- Creates clear visual distinction from other file types
- Provides consistent branding across the audio feature

## 6. Accessibility Features

- **Keyboard Navigation:** Audio controls are keyboard accessible
- **Screen Readers:** Proper ARIA labels for all interactive elements
- **High Contrast:** Color combinations meet WCAG AA standards
- **Focus Indicators:** Clear focus states on all buttons and controls

## 7. Responsive Design

- **Desktop:** Full-width audio player with all controls visible
- **Tablet:** Responsive controls, may show simplified timeline
- **Mobile:** Stacked layout, native mobile audio controls
- **Small screens:** Filename may truncate with ellipsis (...)

## 8. Browser Compatibility

The audio player uses HTML5 `<audio>` element which is supported by:
- ✅ Chrome/Edge 4+
- ✅ Firefox 3.5+
- ✅ Safari 4+
- ✅ Opera 10.5+
- ✅ iOS Safari (all versions)
- ✅ Android Browser 2.3+

**Fallback:** If browser doesn't support audio element, displays message:
"Your browser does not support audio playback."

## Technical Implementation Notes

1. **Audio Storage:** Base64 encoded in message metadata
2. **Playback:** Uses data URI in `<audio src="...">`
3. **Format Support:** Depends on browser codec support
4. **No External Dependencies:** Pure HTML5, no additional libraries needed
5. **Performance:** Efficient for files under 20MB
