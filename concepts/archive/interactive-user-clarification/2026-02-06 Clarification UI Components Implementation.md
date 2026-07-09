# Clarification UI Components Implementation

**Date:** 2026-02-06
**Feature:** Interactive User Clarification Tool (Client-Side UI)

## Overview

This document describes the implementation of React UI components for the `ask_user` tool's clarification interface. These components enable AI assistants to ask users for additional information during a conversation.

## Components Created

All components are located in `/client/src/features/chat/components/`:

### 1. ClarificationCard.jsx
**Purpose:** Main container component for displaying clarification questions.

**Features:**
- Displays question with optional context
- Automatically selects chip or dropdown based on option count (threshold: 4 options)
- Handles all input types: single_select, multi_select, text, number, date, date_range, file
- Submit and skip actions
- Full accessibility with ARIA attributes and focus management
- Keyboard navigation (Ctrl+Enter to submit)
- Focus trap within the card

**Props:**
```javascript
{
  // Object-style API (for backward compatibility)
  clarification: {
    questionId: string,
    question: string,
    inputType: string,
    options: Array,
    allowOther: boolean,
    allowSkip: boolean,
    context: string
  },
  // Explicit props API
  question: string,
  inputType: 'single_select' | 'multi_select' | 'text' | 'number' | 'date' | 'date_range' | 'file',
  options: Array<{label: string, value: string, description?: string}>,
  allowOther: boolean,
  allowSkip: boolean,
  placeholder: string,
  context: string,
  onSubmit: (response) => void,
  onSkip: () => void,
  disabled: boolean,
  validation: { min, max, minDate, maxDate }
}
```

### 2. ClarificationChips.jsx
**Purpose:** Chip-based selector for 4 or fewer options.

**Features:**
- Single or multi-select mode
- Keyboard navigation (arrow keys, Enter/Space to select)
- Visual feedback with checkmarks for selected items
- Optional "Other" option for custom input
- Touch-friendly with min 44x44px targets

**Props:**
```javascript
{
  options: Array<{label: string, value: string, description?: string}>,
  multiSelect: boolean,
  allowOther: boolean,
  value: string | string[],
  onChange: (value) => void,
  disabled: boolean
}
```

### 3. ClarificationDropdown.jsx
**Purpose:** Dropdown selector for more than 4 options.

**Features:**
- Searchable/filterable options
- Single or multi-select mode with checkboxes
- Keyboard navigation (arrow keys, Enter to select, Escape to close)
- Accessible with ARIA attributes
- Shows selected count for multi-select

**Props:**
```javascript
{
  options: Array<{label: string, value: string, description?: string}>,
  multiSelect: boolean,
  allowOther: boolean,
  value: string | string[],
  onChange: (value) => void,
  placeholder: string,
  disabled: boolean
}
```

### 4. ClarificationInput.jsx
**Purpose:** Input fields for text, number, date, and date_range types.

**Features:**
- Text: Auto-resizing textarea
- Number: Min/max validation with helpful hints
- Date: Single date picker with calendar icon
- Date Range: Start/end date pickers with validation
- Validation error display

**Props:**
```javascript
{
  inputType: 'text' | 'number' | 'date' | 'date_range',
  value: string | number | {start: string, end: string},
  onChange: (value) => void,
  placeholder: string,
  min: number,
  max: number,
  minDate: string,
  maxDate: string,
  disabled: boolean,
  required: boolean
}
```

### 5. ClarificationResponse.jsx
**Purpose:** Display component for answered clarifications in the message flow.

**Features:**
- Shows question with question mark icon
- Shows answer with check icon (or arrow for skipped)
- Supports different value types (string, array, object)
- Compact styling to integrate into message flow
- Visual distinction from regular messages

**Props:**
```javascript
{
  question: string,
  // Object-style API
  response: {
    answered: boolean,
    skipped: boolean,
    value: any,
    displayText: string
  },
  // Explicit props API
  answer: string | string[] | Object,
  options: Array<{label: string, value: string}>,
  inputType: string,
  skipped: boolean,
  context: string
}
```

## Accessibility (WCAG 2.1 AA)

All components implement:
- `role="dialog"` and `aria-modal="true"` on ClarificationCard
- `aria-labelledby` pointing to question
- Focus trapped within card until submitted/skipped
- Keyboard navigation for all interactions
- Minimum 44x44px touch targets
- Proper contrast ratios for dark/light mode
- Screen reader announcements for state changes

## Styling

- Uses Tailwind CSS following existing project patterns
- Supports dark mode via `dark:` prefixes
- Responsive for mobile devices
- Consistent with existing chat components

## Integration Points

### onSubmit Callback
When using the object-style API with `clarification.questionId`:
```javascript
{
  questionId: string,
  answered: true,
  skipped: false,
  value: any,
  displayText: string
}
```

When using explicit props:
```javascript
value // The raw value directly
```

### onSkip Callback
When using object-style API:
```javascript
{
  questionId: string,
  answered: false,
  skipped: true,
  value: null,
  displayText: 'Skipped'
}
```

## i18n Keys

All components use the following translation key prefixes:
- `clarification.` - Main clarification strings
- `clarification.validation.` - Validation error messages
- `common.` - Common strings (cancel, confirm, etc.)

Example keys:
- `clarification.submit` - Submit button text
- `clarification.skip` - Skip button text
- `clarification.other` - Other option label
- `clarification.searchOptions` - Search placeholder
- `clarification.skipped` - Skipped display text
- `clarification.keyboardHint` - Keyboard shortcut hint

## Usage Example

```jsx
import { ClarificationCard, ClarificationResponse } from './clarification';

// Display a pending clarification
<ClarificationCard
  question="What format would you like the report in?"
  inputType="single_select"
  options={[
    { label: 'PDF', value: 'pdf' },
    { label: 'Excel', value: 'xlsx' },
    { label: 'Word', value: 'docx' }
  ]}
  allowOther={true}
  allowSkip={true}
  onSubmit={(value) => console.log('Selected:', value)}
  onSkip={() => console.log('Skipped')}
/>

// Display a completed clarification
<ClarificationResponse
  question="What format would you like the report in?"
  answer="pdf"
  options={[
    { label: 'PDF', value: 'pdf' },
    { label: 'Excel', value: 'xlsx' }
  ]}
/>
```

## File Locations

| Component | Path |
|-----------|------|
| ClarificationCard | `/client/src/features/chat/components/ClarificationCard.jsx` |
| ClarificationChips | `/client/src/features/chat/components/ClarificationChips.jsx` |
| ClarificationDropdown | `/client/src/features/chat/components/ClarificationDropdown.jsx` |
| ClarificationInput | `/client/src/features/chat/components/ClarificationInput.jsx` |
| ClarificationResponse | `/client/src/features/chat/components/ClarificationResponse.jsx` |

## Next Steps

1. Add translations for clarification keys to locale files
2. Integrate ClarificationCard into ChatMessage component
3. Add file upload support using existing UnifiedUploader
4. Add unit tests for component behavior
