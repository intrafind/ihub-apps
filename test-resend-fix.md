# Manual Test Plan: Resend Functionality for Apps with Variables

## Issue Description

Resend functionality was failing for apps with variables due to a race condition between React state updates and form submission.

## Test Case: Social Media App

### Setup

1. Enable the social media app in `contents/apps/social-media.json` (set `enabled: true`)
2. Start the development server: `npm run dev`
3. Navigate to the Social Media app

### Test Steps

#### Test 1: Basic Resend with Required Variables

1. Fill in all required fields:
   - Number of Posts: 3 posts
   - Post Type: Text posts
   - Platform: LinkedIn
   - Topic: "AI in healthcare"
2. Click Send
3. Wait for the response from the AI
4. Click the "Resend" button on the assistant's response

**Expected Result**:

- The message should be resent successfully
- No error message about missing required fields
- All variable values should be preserved

#### Test 2: Resend from User Message

1. After receiving a response, click the "Resend" button on the user's message (not the assistant's)

**Expected Result**:

- The message should be resent successfully
- All variable values should be preserved

#### Test 3: Resend with Optional Variables

1. Fill in all fields including optional ones:
   - Number of Posts: 1 post
   - Post Type: Promotional posts
   - Platform: Twitter/X
   - Topic: "New product launch"
   - Tone: Professional
   - Additional Instructions: "Include emojis"
2. Click Send
3. Wait for response
4. Click Resend

**Expected Result**:

- All variables (including optional ones) should be preserved
- Message should be resent successfully

#### Test 4: Edit and Resend

1. Send a message with variables filled in
2. Click "Edit" on the message
3. Modify the text (not the variables)
4. Click to resend the edited message

**Expected Result**:

- Variables should still be preserved
- Edited content should be sent

### Fix Verification

The fix implements:

1. A `pendingVariablesRef` to store variables during resend operations
2. Modified `handleResendMessage` to store variables in the ref
3. Modified `handleSubmit` to check the ref before the state
4. Proper cleanup of the ref after submission

### Regression Testing

Also verify that normal message submission (without resend) still works:

1. Enter text and fill variables manually
2. Submit the form normally

**Expected Result**:

- Should work exactly as before the fix
- No regression in normal workflow

## Technical Details

### Root Cause

- `setVariables()` is asynchronous in React
- `setTimeout(..., 0)` was triggering form submission before state update completed
- Validation was checking old/empty variables state

### Solution

- Use `useRef` to store pending variables for immediate access
- Check ref first in validation, falling back to state
- Clear ref after successful submission or validation failure

## Test Environment

- Browser: Chrome/Firefox (test both)
- React version: (check package.json)
- Node version: v24.13.0

## Success Criteria

✅ All test cases pass without errors
✅ No regression in normal message submission
✅ Variables are preserved correctly on resend
✅ No console errors during resend operation
