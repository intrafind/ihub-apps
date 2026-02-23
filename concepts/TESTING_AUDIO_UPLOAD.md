# Testing Audio File Upload Support

This document provides instructions for manually testing the audio file upload feature.

## Prerequisites

1. **Google API Key**: Set up a Google API key with Gemini 2.0 access

   ```bash
   export GOOGLE_API_KEY="your-api-key-here"
   ```

2. **Test Audio Files**: Prepare test audio files in various formats:
   - MP3 file (recommended: < 5MB)
   - WAV file (recommended: < 5MB)
   - FLAC file (optional)
   - OGG file (optional)

3. **Running Server**: Ensure the server is running
   ```bash
   npm run dev
   ```

## Test Cases

### 1. Basic Audio Upload

**Steps**:

1. Navigate to the Audio Transcription app
2. Click the upload button (📎)
3. Select an MP3 or WAV file
4. Enter prompt: "Transcribe this audio"
5. Submit the message

**Expected Result**:

- File uploads successfully
- Audio file indicator (🎵 filename) appears
- Model transcribes the audio content
- Response includes full transcription

### 2. Multiple Audio Files

**Steps**:

1. Upload multiple audio files in one message
2. Submit with prompt: "Transcribe all audio files"

**Expected Result**:

- All files upload successfully
- Multiple audio indicators appear
- Model processes all audio files
- Response includes transcriptions for all files

### 3. Audio + Image Upload

**Steps**:

1. Create an app with both image and audio upload enabled
2. Upload an image and an audio file together
3. Submit with prompt: "Describe the image and transcribe the audio"

**Expected Result**:

- Both file types upload successfully
- Both indicators appear (image preview + 🎵 audio)
- Model processes both files
- Response addresses both media types

### 4. Speaker Identification

**Steps**:

1. Upload audio with multiple speakers (e.g., conversation, interview)
2. Use starter prompt: "Identify the speakers"

**Expected Result**:

- Model identifies different speakers
- Response labels speakers (Speaker 1, Speaker 2, etc.)
- Transcription includes speaker attribution

### 5. Sentiment Analysis

**Steps**:

1. Upload emotional audio (e.g., excited speech, sad narration)
2. Use starter prompt: "What is the sentiment and tone of this audio?"

**Expected Result**:

- Model analyzes emotional content
- Response describes sentiment (positive, negative, neutral)
- Response describes tone (excited, calm, angry, etc.)

### 6. Audio Summarization

**Steps**:

1. Upload longer audio (2-5 minutes)
2. Use starter prompt: "Summarize the main points"

**Expected Result**:

- Model processes full audio
- Response provides concise summary
- Key points highlighted

### 7. Error Handling Tests

#### File Too Large

**Steps**:

1. Try to upload audio file > 20MB

**Expected Result**:

- Error message: "File too large. Maximum size is 20MB."

#### Unsupported Format

**Steps**:

1. Try to upload non-audio file (e.g., video, document)

**Expected Result**:

- Error message: "Unsupported file format. Please use: MP3, WAV, FLAC, OGG"

#### Wrong Model Selected

**Steps**:

1. Select a non-Gemini 2.0 model (e.g., GPT-4)
2. Try to upload audio

**Expected Result**:

- Audio upload button disabled or error shown
- Message: "Audio upload is not supported by the selected model"

### 8. Resend Functionality

**Steps**:

1. Send message with audio file
2. Click resend on the message
3. Optionally edit the prompt
4. Submit

**Expected Result**:

- Audio file reattached to new message
- Message sent with same audio
- Model processes audio again

## Verification Checklist

- [ ] Server starts without errors
- [ ] Audio Transcription app appears in app list
- [ ] Gemini 2.0 models appear in model selector
- [ ] Upload button works for audio files
- [ ] File size validation works (20MB limit)
- [ ] Format validation works (MP3, WAV, FLAC, OGG only)
- [ ] Audio indicator (🎵) displays correctly
- [ ] Single audio file upload works
- [ ] Multiple audio file upload works
- [ ] Audio + image combination works
- [ ] Transcription accuracy is acceptable
- [ ] Speaker identification works (if applicable)
- [ ] Sentiment analysis works
- [ ] Error messages are clear and helpful
- [ ] Resend functionality preserves audio files
- [ ] Model switching disables audio upload for non-compatible models

## Audio Quality Test

Test with different audio qualities to verify transcription accuracy:

1. **High Quality** (WAV, 44.1kHz, stereo)
   - Expected: Excellent transcription accuracy

2. **Medium Quality** (MP3, 128kbps, 16kHz, mono)
   - Expected: Good transcription accuracy

3. **Low Quality** (MP3, 64kbps, 8kHz, mono)
   - Expected: Acceptable accuracy with some errors

4. **Noisy Audio** (background noise, multiple speakers)
   - Expected: Reduced accuracy, may miss some words

## Common Issues

### Audio Not Processing

**Problem**: Model doesn't respond to audio
**Solutions**:

- Verify Gemini 2.0 model is selected
- Check GOOGLE_API_KEY is set correctly
- Check server logs for API errors
- Verify file is under 20MB

### Poor Transcription Quality

**Problem**: Transcription has many errors
**Solutions**:

- Use WAV format instead of MP3
- Ensure audio is clear with minimal background noise
- Try shorter clips (under 5 minutes)
- Increase audio sample rate (16kHz minimum)

### Upload Fails

**Problem**: File upload doesn't work
**Solutions**:

- Check file size (must be under 20MB)
- Verify file format (MP3, WAV, FLAC, or OGG)
- Check browser console for errors
- Try different audio file

## Sample Audio Files

For testing purposes, you can:

1. Record your own audio using a voice recorder app
2. Use text-to-speech to generate test audio
3. Download Creative Commons audio from sources like:
   - Freesound.org
   - Archive.org
   - Free Music Archive

**Important**: Do not upload copyrighted content without permission.

## Reporting Issues

When reporting issues, include:

1. Browser and version
2. Audio file format and size
3. Selected model
4. Complete error message
5. Browser console logs
6. Server logs (if available)

## Success Criteria

✅ The feature is working correctly if:

- Audio files upload without errors
- Model successfully processes audio content
- Transcriptions are accurate and complete
- Error handling works as expected
- UI indicators display correctly
- Multiple file uploads work
- Resend functionality preserves audio
