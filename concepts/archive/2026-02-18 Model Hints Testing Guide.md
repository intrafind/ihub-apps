# Model Hints Feature - Testing Guide

## Manual Testing Checklist

### Prerequisites
1. Server running on `localhost:3000`
2. Client running on `localhost:5173`
3. Example models enabled in `contents/models/`
4. Anonymous user has `models: ["*"]` permission in `groups.json`

### Test 1: Hint Level (Blue)
**Model**: `gpt-4-turbo-hint-example`

**Steps**:
1. Navigate to an app with chat (e.g., `/apps/chat`)
2. Select "GPT-4 Turbo (Hint Example)" from model dropdown
3. Observe blue hint banner appears below model selector
4. Verify message: "This model is optimized for quick responses..."
5. Verify [×] dismiss button is visible
6. Click [×] button
7. Verify banner disappears
8. Verify input field remains enabled
9. Switch to different model and back
10. Verify hint appears again (not permanently dismissed)

**Expected Results**:
- ✅ Blue background (light mode) or dark blue (dark mode)
- ✅ Info circle icon visible
- ✅ Dismiss button functional
- ✅ Input field always enabled
- ✅ Hint reappears after model switch

### Test 2: Info Level (Cyan)
**Model**: `claude-3-info-example`

**Steps**:
1. Select "Claude 3 Opus (Info Example)" from model dropdown
2. Observe cyan hint banner appears
3. Verify message: "This model provides excellent reasoning capabilities..."
4. Verify [×] dismiss button is visible
5. Click [×] button
6. Verify banner disappears
7. Type a message and verify send works

**Expected Results**:
- ✅ Cyan background (slightly different from blue)
- ✅ Info circle icon visible
- ✅ Dismissible
- ✅ No impact on chat functionality

### Test 3: Warning Level (Yellow)
**Model**: `gemini-warning-example`

**Steps**:
1. Select "Gemini Pro (Warning Example)" from model dropdown
2. Observe yellow warning banner appears
3. Verify message: "This model is being deprecated..."
4. Verify NO [×] dismiss button (non-dismissible)
5. Try to use chat input
6. Verify input works normally
7. Verify warning remains visible while typing
8. Switch to different model
9. Verify warning disappears
10. Switch back to warning model
11. Verify warning reappears immediately

**Expected Results**:
- ✅ Yellow background with exclamation triangle icon
- ✅ NO dismiss button
- ✅ Warning always visible when model selected
- ✅ Input field remains enabled
- ✅ Warning is persistent but not blocking

### Test 4: Alert Level (Red with Acknowledgment)
**Model**: `experimental-alert-example`

**Steps**:
1. Select "Experimental Model (Alert Example)" from model dropdown
2. Observe red alert banner appears
3. Verify banner shows "Important Notice" title
4. Verify message: "⚠️ EXPERIMENTAL MODEL ⚠️..."
5. Verify [I Understand] button is visible
6. **Verify input field is DISABLED** (should be grayed out)
7. Try to type in input field - should not work
8. Try to click Send button - should be disabled
9. Click [I Understand] button
10. Verify input field becomes ENABLED
11. Verify alert banner remains visible (doesn't disappear)
12. Type a test message and verify it works
13. Switch to different model
14. Switch back to alert model
15. **Verify input is disabled again** (must re-acknowledge)
16. Click [I Understand] again to enable

**Expected Results**:
- ✅ Red background with exclamation triangle icon
- ✅ "Important Notice" title displayed
- ✅ [I Understand] button visible and functional
- ✅ Input DISABLED until acknowledgment
- ✅ Alert remains visible after acknowledgment
- ✅ Acknowledgment resets on model switch

### Test 5: Internationalization
**Prerequisites**: Change language to German

**Steps**:
1. Switch UI language to German (de)
2. Select each example model one by one
3. Verify all hint messages appear in German:
   - Hint: "Dieses Modell ist für schnelle Antworten optimiert..."
   - Info: "Dieses Modell bietet hervorragende Reasoning-Fähigkeiten..."
   - Warning: "Dieses Modell wird eingestellt..."
   - Alert: "⚠️ EXPERIMENTELLES MODELL ⚠️..."
4. Verify UI buttons are in German:
   - Dismiss: "Ausblenden"
   - Acknowledge: "Verstanden"
   - Alert Title: "Wichtiger Hinweis"

**Expected Results**:
- ✅ All hint messages in German
- ✅ All UI elements localized
- ✅ Proper German grammar and formatting

### Test 6: Dark Mode
**Steps**:
1. Toggle to dark mode
2. Test each hint level (hint, info, warning, alert)
3. Verify colors are appropriate for dark background:
   - Blue hint on dark blue background
   - Cyan info on dark cyan background
   - Yellow warning on dark yellow background
   - Red alert on dark red background
4. Verify text is readable in all cases

**Expected Results**:
- ✅ All hint levels visible in dark mode
- ✅ Sufficient contrast for readability
- ✅ Icons properly colored
- ✅ Buttons visible and functional

### Test 7: Model Without Hint
**Model**: Any standard model without hint (e.g., `gemini-2.0-flash`)

**Steps**:
1. Select a model that doesn't have a hint configured
2. Verify NO hint banner appears
3. Verify input field is enabled
4. Verify chat works normally

**Expected Results**:
- ✅ No hint banner displayed
- ✅ Normal chat functionality
- ✅ No extra spacing where hint would be

### Test 8: Multiple Model Switches
**Steps**:
1. Select alert model → acknowledge → switch away
2. Select warning model → read warning → switch away
3. Select info model → dismiss → switch away
4. Select hint model → dismiss → switch away
5. Go back to alert model
6. Verify must acknowledge again (state reset)
7. Go back to info model
8. Verify hint appears again (dismiss was temporary)

**Expected Results**:
- ✅ Each model's hint behaves correctly
- ✅ State resets appropriately on model change
- ✅ No memory leaks or UI glitches

### Test 9: Long Messages
**Model**: Create a test model with a very long hint message

**Steps**:
1. Create a model with 500+ character hint message
2. Select the model
3. Verify message wraps properly
4. Verify no horizontal scrolling
5. Verify buttons remain visible
6. Verify message is fully readable

**Expected Results**:
- ✅ Text wraps to multiple lines
- ✅ Banner expands vertically
- ✅ No text overflow
- ✅ Maintains readability

### Test 10: Rapid Model Switching
**Steps**:
1. Quickly switch between models with different hint levels
2. Switch 10+ times rapidly
3. Verify no UI glitches
4. Verify correct hint always displays
5. Verify no overlapping hints

**Expected Results**:
- ✅ UI remains stable
- ✅ Only one hint displayed at a time
- ✅ Correct hint for selected model
- ✅ No performance issues

## API Testing

### Test API 1: Model Hint Data Structure
```bash
# Get all models
curl http://localhost:3000/api/models | jq '.[] | select(.hint != null)'

# Expected output includes:
{
  "id": "experimental-alert-example",
  "hint": {
    "message": {
      "en": "⚠️ EXPERIMENTAL MODEL ⚠️...",
      "de": "⚠️ EXPERIMENTELLES MODELL ⚠️..."
    },
    "level": "alert",
    "dismissible": false
  }
}
```

### Test API 2: Hint Validation
```bash
# Try to create invalid model (should fail validation)
curl -X POST http://localhost:3000/api/admin/models \
  -H "Content-Type: application/json" \
  -d '{
    "id": "test-invalid-hint",
    "modelId": "test",
    "name": {"en": "Test"},
    "hint": {
      "message": {"en": "Test"},
      "level": "invalid-level"
    }
  }'

# Expected: Validation error about invalid level
```

## Automated Testing Suggestions

### Unit Tests (Component)
```javascript
describe('ModelHintBanner', () => {
  test('renders hint level correctly', () => {
    // Test blue background, info icon, dismissible
  });
  
  test('renders info level correctly', () => {
    // Test cyan background, info icon, dismissible
  });
  
  test('renders warning level correctly', () => {
    // Test yellow background, warning icon, non-dismissible
  });
  
  test('renders alert level correctly', () => {
    // Test red background, warning icon, acknowledge button
  });
  
  test('dismissible hints can be dismissed', () => {
    // Click dismiss, verify banner disappears
  });
  
  test('alert acknowledgment calls callback', () => {
    // Click acknowledge, verify callback fired
  });
  
  test('localization works', () => {
    // Test English and German messages
  });
});
```

### Integration Tests (ChatInput)
```javascript
describe('ChatInput with Model Hints', () => {
  test('displays hint when model with hint selected', () => {
    // Select model, verify hint appears
  });
  
  test('hides hint when model without hint selected', () => {
    // Select model, verify no hint
  });
  
  test('disables input for alert level', () => {
    // Select alert model, verify input disabled
  });
  
  test('enables input after alert acknowledgment', () => {
    // Acknowledge alert, verify input enabled
  });
  
  test('resets acknowledgment on model change', () => {
    // Acknowledge, switch away, switch back, verify disabled again
  });
});
```

## Performance Testing

### Test P1: Render Performance
- Select models with hints 100 times
- Measure average render time
- Should be < 50ms per render

### Test P2: Memory Leaks
- Switch between models 1000 times
- Monitor memory usage
- Should not exceed 10MB growth

### Test P3: Large Message Performance
- Create hint with 10,000 character message
- Verify rendering remains smooth
- Should render in < 100ms

## Regression Testing

After any changes to:
- ModelHintBanner component
- ChatInput component
- Model schema
- i18n files

Re-run all manual tests to ensure no regressions.

## Known Limitations

1. **Single Hint Per Model**: Each model can only have one hint
2. **No Hint History**: Dismissed hints don't persist across sessions
3. **No Hint Analytics**: Can't track which hints are most dismissed
4. **Static Content**: Hints can't contain dynamic data or links
5. **No Scheduled Hints**: Can't show hints only during specific time periods

## Future Test Cases

When implementing future enhancements:
- Test persistent acknowledgment across sessions
- Test hint expiration dates
- Test link support in messages
- Test hint analytics tracking
- Test admin UI for hint management
