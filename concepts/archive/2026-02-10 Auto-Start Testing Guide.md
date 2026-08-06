# Auto-Start Feature Testing Guide

This guide provides step-by-step instructions for testing the auto-start chat feature.

## Prerequisites

1. Development environment set up with:
   ```bash
   npm run setup:dev
   ```

2. At least one API key configured in `.env` (e.g., `GOOGLE_API_KEY` for Gemini models)

3. Server and client running:
   ```bash
   npm run dev
   ```

## Test Cases

### Test 1: Basic Auto-Start Functionality

**Objective:** Verify that an app with `autoStart: true` automatically initiates the conversation

**Steps:**
1. Navigate to the Apps page at `http://localhost:5173/apps`
2. Find and click on "Personal Coach" (or create a new app with `autoStart: true`)
3. Observe the chat interface

**Expected Result:**
- The LLM should automatically send a greeting message without user input
- NO empty user message should be visible in the chat history
- The first visible message should be from the assistant
- The greeting should be contextual based on the system prompt

**Pass Criteria:**
- ✅ Auto-greeting appears within 1-2 seconds of page load
- ✅ No empty user message visible
- ✅ User can respond to the greeting immediately

---

### Test 2: App Without Auto-Start

**Objective:** Verify normal behavior for apps without auto-start enabled

**Steps:**
1. Navigate to an app with `autoStart: false` or undefined (e.g., "AI Chat")
2. Observe the chat interface

**Expected Result:**
- Chat should show empty state (greeting/starter prompts if configured)
- No automatic LLM message
- User must send the first message

**Pass Criteria:**
- ✅ No automatic greeting
- ✅ Normal empty chat state
- ✅ User can send first message manually

---

### Test 3: Chat Reset/Clear

**Objective:** Verify auto-start triggers again after clearing chat

**Steps:**
1. Open "Personal Coach" app (auto-start enabled)
2. Wait for initial auto-start greeting
3. Send a reply message
4. Click the "Clear Chat" button (trash icon or menu option)
5. Confirm the clear action

**Expected Result:**
- After clearing, the LLM should auto-start again
- A new greeting message should appear
- Previous conversation should be cleared

**Pass Criteria:**
- ✅ Auto-start triggers after clear
- ✅ New greeting appears
- ✅ Previous messages removed

---

### Test 4: App Switching

**Objective:** Verify auto-start behavior when switching between apps

**Steps:**
1. Open "Personal Coach" (auto-start enabled)
2. Wait for auto-greeting
3. Switch to "AI Chat" (auto-start disabled)
4. Observe behavior
5. Switch back to "Personal Coach"
6. Observe behavior

**Expected Result:**
- "Personal Coach" auto-starts on first visit
- "AI Chat" does not auto-start
- "Personal Coach" does NOT auto-start again (conversation preserved)

**Pass Criteria:**
- ✅ Each app respects its own auto-start setting
- ✅ No duplicate auto-start on return to same app
- ✅ Chat history preserved when switching

---

### Test 5: Apps with Variables

**Objective:** Verify auto-start works with apps that have input variables

**Steps:**
1. Create or find an app with:
   - `autoStart: true`
   - Variables defined with default values
2. Open the app
3. Observe the auto-start behavior

**Expected Result:**
- Auto-start should use default variable values
- Greeting message should incorporate default variables appropriately
- User can modify variables after auto-start

**Pass Criteria:**
- ✅ Auto-start works with variables
- ✅ Default values used correctly
- ✅ Variables can be changed post-start

---

### Test 6: Admin Configuration UI

**Objective:** Verify the admin UI for configuring auto-start

**Steps:**
1. Navigate to Admin → Apps
2. Create a new chat app or edit existing one
3. Scroll to the "Auto-start conversation" checkbox
4. Toggle the checkbox
5. Save the app
6. Reload the app configuration
7. Verify the setting persisted

**Expected Result:**
- Checkbox visible in admin form
- Help text explains the feature
- Setting saves correctly
- Setting loads correctly on reload

**Pass Criteria:**
- ✅ Checkbox visible and functional
- ✅ Help text displayed
- ✅ Setting persists after save
- ✅ Setting loads correctly

---

### Test 7: Multiple Models

**Objective:** Verify auto-start works with different LLM models

**Steps:**
1. Open auto-start app
2. Wait for initial greeting
3. Change the model in settings
4. Clear the chat
5. Observe if auto-start works with new model

**Expected Result:**
- Auto-start should work regardless of selected model
- Different models may produce different greetings
- No errors in console

**Pass Criteria:**
- ✅ Works with multiple models
- ✅ Model change doesn't break auto-start
- ✅ No console errors

---

### Test 8: Edge Case - Rapid Actions

**Objective:** Verify auto-start handles rapid user actions gracefully

**Steps:**
1. Open auto-start app
2. Immediately navigate away before greeting appears
3. Navigate back
4. Observe behavior

**Expected Result:**
- No duplicate auto-starts
- No error messages
- Single greeting when returning

**Pass Criteria:**
- ✅ No duplicate greetings
- ✅ No errors in console
- ✅ Graceful handling

---

### Test 9: Network Delays

**Objective:** Verify auto-start handles slow API responses

**Steps:**
1. Use browser DevTools to throttle network to "Slow 3G"
2. Open auto-start app
3. Observe behavior

**Expected Result:**
- Loading state while waiting for greeting
- Greeting eventually appears
- No timeout errors
- No duplicate requests

**Pass Criteria:**
- ✅ Shows loading state
- ✅ Greeting appears eventually
- ✅ No errors

---

### Test 10: Example App Verification

**Objective:** Verify the example coach-dialog.json app works correctly

**Steps:**
1. Copy `examples/apps/coach-dialog.json` to `contents/apps/`
2. Restart server (or wait for hot-reload)
3. Navigate to the app
4. Test auto-start functionality

**Expected Result:**
- App appears in apps list
- Auto-start works as expected
- Coaching-style greeting appears

**Pass Criteria:**
- ✅ Example app loads
- ✅ Auto-start functional
- ✅ Appropriate greeting

---

## Debugging

If auto-start doesn't work:

1. **Check Console Logs:**
   - Look for: "Auto-starting conversation for app: [appId]"
   - Check for errors related to message sending

2. **Verify Configuration:**
   ```javascript
   // In browser console
   // Check app config
   const response = await fetch('/api/apps/coach-dialog');
   const app = await response.json();
   console.log('Auto-start enabled:', app.autoStart);
   ```

3. **Check Dependencies:**
   - Verify model is selected
   - Verify variables are initialized
   - Check that messages array is empty

4. **Network Tab:**
   - Look for POST to `/api/apps/[appId]/chat/[chatId]`
   - Verify request payload includes empty content

## Success Criteria

All tests should pass for the feature to be considered complete:
- ✅ Auto-start triggers correctly
- ✅ Empty messages filtered from UI
- ✅ Works across different scenarios
- ✅ Admin UI functional
- ✅ No console errors
- ✅ Performance acceptable (< 2 seconds to auto-start)

## Known Limitations

1. Auto-start requires at least one enabled model
2. Auto-start delay is fixed at 300ms (not configurable)
3. Auto-start sends empty content (not customizable message)

## Reporting Issues

If you find bugs:
1. Document the exact steps to reproduce
2. Include browser console errors
3. Note the app configuration used
4. Include network requests/responses
5. Note browser and version
