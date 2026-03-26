# Azure Speech to Text Auto vs Manual Mode Support

## Issue Summary

The Azure Speech to Text service was not properly supporting both automatic and manual microphone modes. It only implemented single-shot recognition (`recognizeOnceAsync`), which meant:

- **Automatic mode** worked (stops automatically when user pauses speaking)
- **Manual mode** did NOT work (should continue listening until user explicitly stops)

## Problem Analysis

### Root Cause

The `AzureSpeechRecognition` class in `client/src/utils/azureRecognitionService.js` only used:
- `recognizeOnceAsync()` - Single-shot recognition that stops automatically
- No support for `startContinuousRecognitionAsync()` - Required for manual/continuous mode
- No `stop()` method to stop continuous recognition
- No handling of interim results from continuous recognition

### Expected Behavior

According to the microphone feature documentation:
- **Automatic mode** (`app.inputMode.microphone.mode = "automatic"`): Recognition stops automatically when user pauses
- **Manual mode** (`app.inputMode.microphone.mode = "manual"`): Recognition continues until user clicks microphone button again

## Solution Implemented

### Changes to `azureRecognitionService.js`

1. **Added properties to support mode selection:**
   ```javascript
   continuous = false;
   interimResults = false;
   ```

2. **Updated `start()` method** to choose recognition mode:
   ```javascript
   start() {
     this.#triggerOnStart();

     if (this.continuous) {
       // Use continuous recognition for manual mode
       this.#startContinuousRecognition();
     } else {
       // Use single-shot recognition for automatic mode
       this.#startSingleShotRecognition();
     }
   }
   ```

3. **Implemented `stop()` method** for manual mode:
   ```javascript
   stop() {
     if (this.continuous && this.recognition) {
       this.recognition.stopContinuousRecognitionAsync(
         () => {
           console.log('Continuous recognition stopped');
           this.#triggerOnEnd();
         },
         err => {
           console.error('Error stopping continuous recognition:', err);
           this.#triggerOnError({ error: 'network' });
         }
       );
     }
   }
   ```

4. **Created `#startSingleShotRecognition()` method** - Refactored existing logic for automatic mode

5. **Created `#startContinuousRecognition()` method** - New implementation for manual mode:
   - Subscribes to `recognizing` event for interim results
   - Subscribes to `recognized` event for final results
   - Subscribes to `canceled` event for error handling
   - Subscribes to `sessionStopped` event for session lifecycle
   - Calls `startContinuousRecognitionAsync()` to begin continuous recognition

### Changes to `useVoiceRecognition.js`

Updated the `onresult` handler to properly distinguish between:
- **Browser SpeechRecognition API** (existing logic unchanged)
- **Azure Speech Recognition API** with new support for:
  - Interim results (`event.isFinal === false`)
  - Final results (`event.isFinal !== false`)

```javascript
if (!isAzure) {
  // Browser SpeechRecognition API
  for (let i = event.resultIndex; i < event.results.length; i++) {
    const transcript = event.results[i][0].transcript;
    const isFinal = event.results[i].isFinal;
    if (isFinal) {
      finalTranscript += transcript;
    } else {
      interimTranscript += transcript;
    }
  }
} else {
  // Azure Speech Recognition API
  if ('text' in event) {
    // Check if this is a final or interim result
    if (event.isFinal === false) {
      // Interim result from continuous recognition
      interimTranscript = event.text;
    } else {
      // Final result (from either recognizeOnceAsync or continuous recognition)
      finalTranscript = event.text;
    }
  }
}
```

## How It Works

### Automatic Mode Flow

1. User clicks microphone button
2. `useVoiceRecognition` sets `recognition.continuous = false` (based on `microphoneMode`)
3. `azureRecognitionService.start()` calls `#startSingleShotRecognition()`
4. Azure SDK uses `recognizeOnceAsync()` - stops when user pauses
5. Final result is returned via `onresult` handler
6. Recognition automatically ends

### Manual Mode Flow

1. User clicks microphone button
2. `useVoiceRecognition` sets `recognition.continuous = true` (based on `microphoneMode`)
3. `azureRecognitionService.start()` calls `#startContinuousRecognition()`
4. Azure SDK uses `startContinuousRecognitionAsync()` - keeps listening
5. Interim results are sent via `recognizing` event (if `interimResults = true`)
6. Final results are sent via `recognized` event for each speech segment
7. User clicks microphone button again to stop
8. `useVoiceRecognition` calls `recognition.stop()`
9. `azureRecognitionService.stop()` calls `stopContinuousRecognitionAsync()`
10. Recognition ends

## Configuration Example

### Automatic Mode (Default)
```json
{
  "id": "my-app",
  "inputMode": {
    "type": "multiline",
    "microphone": {
      "enabled": true,
      "mode": "automatic"
    }
  },
  "settings": {
    "speechRecognition": {
      "service": "azure",
      "host": "https://westeurope.stt.speech.microsoft.com"
    }
  }
}
```

### Manual Mode with Interim Results
```json
{
  "id": "my-app",
  "inputMode": {
    "type": "multiline",
    "microphone": {
      "enabled": true,
      "mode": "manual",
      "showTranscript": true
    }
  },
  "settings": {
    "speechRecognition": {
      "service": "azure",
      "host": "https://westeurope.stt.speech.microsoft.com"
    }
  }
}
```

## Testing Recommendations

### Manual Testing Steps

1. **Test Automatic Mode:**
   - Configure app with `mode: "automatic"`
   - Click microphone button
   - Speak a sentence and pause
   - Verify recognition stops automatically after pause
   - Verify text appears in input field

2. **Test Manual Mode:**
   - Configure app with `mode: "manual"`
   - Click microphone button
   - Speak multiple sentences with pauses
   - Verify recognition continues through pauses
   - Click microphone button again to stop
   - Verify all text accumulated in input field

3. **Test Interim Results (Manual Mode):**
   - Configure app with `mode: "manual"` and `showTranscript: true`
   - Click microphone button
   - Speak slowly
   - Verify interim text appears in real-time
   - Verify final text replaces interim text after each sentence

4. **Test Error Handling:**
   - Test with invalid Azure credentials (should show error)
   - Test with network disconnection (should show network error)
   - Test stopping recognition immediately after starting

## Files Modified

- `client/src/utils/azureRecognitionService.js` - Core Azure Speech SDK integration
- `client/src/features/voice/hooks/useVoiceRecognition.js` - React hook for voice recognition

## Related Documentation

- `docs/microphone-feature.md` - Comprehensive microphone feature documentation
- Azure Speech SDK JavaScript Reference: https://learn.microsoft.com/en-us/javascript/api/microsoft-cognitiveservices-speech-sdk/speechrecognizer

## Technical Notes

### Azure Speech SDK Event Handlers

The continuous recognition mode relies on event handlers rather than async callbacks:

- **`recognizing`**: Fires continuously during speech recognition (interim results)
- **`recognized`**: Fires when a speech segment is completed (final results)
- **`canceled`**: Fires on errors or when recognition is canceled
- **`sessionStopped`**: Fires when the recognition session ends

### Compatibility

- Browser SpeechRecognition API behavior unchanged
- Azure single-shot recognition behavior unchanged (backward compatible)
- New continuous recognition only activates when `continuous = true`

## Future Improvements

1. Add configuration option to adjust silence timeout for continuous mode
2. Add unit tests for both automatic and manual modes
3. Add integration tests with mock Azure SDK
4. Consider adding visual feedback for interim vs final results
