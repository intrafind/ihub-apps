# Auto-Send Feature Documentation

This folder contains comprehensive documentation for the auto-send query parameter feature.

## Overview

The auto-send feature allows URLs to automatically submit prefilled messages when the page loads, eliminating the need for users to manually click the send button.

## Documentation Files

### User Documentation
- **[AUTO_SEND_FEATURE.md](AUTO_SEND_FEATURE.md)** - Complete feature documentation with examples and troubleshooting
- **[AUTO_SEND_QUICK_REFERENCE.md](AUTO_SEND_QUICK_REFERENCE.md)** - Quick start guide and usage examples

### Technical Documentation
- **[2026-02-02 auto-send-query-parameter.md](2026-02-02%20auto-send-query-parameter.md)** - Technical concept document with implementation details
- **[IMPLEMENTATION_SUMMARY_AUTO_SEND.md](IMPLEMENTATION_SUMMARY_AUTO_SEND.md)** - Complete implementation summary

### Visual Documentation
- **[AUTO_SEND_VISUAL_FLOW.md](AUTO_SEND_VISUAL_FLOW.md)** - Visual flow diagrams and state transitions
- **[AUTO_SEND_VISUAL_MOCKUP.md](AUTO_SEND_VISUAL_MOCKUP.md)** - UX mockups and user journey visualization

## Quick Start

Add `send=true` to URLs with prefilled messages:

```
/apps/platform?prefill=Your%20question&send=true
```

The message will be automatically sent when the page loads.

## Key Features

- ✅ Automatic message submission
- ✅ Single execution guard
- ✅ URL cleanup after send
- ✅ App change handling
- ✅ Backwards compatible

## Implementation

**Modified Files**: 1
- `client/src/features/apps/pages/AppChat.jsx` (+28 lines)

See [IMPLEMENTATION_SUMMARY_AUTO_SEND.md](IMPLEMENTATION_SUMMARY_AUTO_SEND.md) for complete details.
