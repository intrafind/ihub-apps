# Websearch Keyboard Activation Fix

**Date**: 2026-04-21
**Issue**: #1295 - WCAG issue: Websearch can't be activated via keys
**Related**: #1225 - Accessibility (Barrierefreiheit) – WCAG 2.1 AA Compliance Audit & Remediation

## Problem

The websearch toggle in the ChatInputActionsMenu was not keyboard-accessible. Users could tab to the element but couldn't activate it using Space, Enter, or arrow keys, violating WCAG 2.1 Level AA criterion 2.1.1 (Keyboard).

## Root Cause

The websearch toggle was implemented as a checkbox wrapped in a label, but:
1. It was not added to the `menuNavItems` array used for keyboard navigation
2. The `useKeyboardNavigation` hook was set up without an `onSelect` callback
3. It lacked the proper ARIA attributes and keyboard event handlers needed for menu items

## Solution

The fix involved three key changes to `client/src/features/chat/components/ChatInputActionsMenu.jsx`:

### 1. Added `onSelect` Callback to `useKeyboardNavigation` Hook

```javascript
const handleMenuItemSelect = useCallback(
  index => {
    // Build menuNavItems array matching DOM order
    const menuNavItems = [];
    // ... add all menu items including 'websearch'

    const selectedKey = menuNavItems[index];
    if (selectedKey === 'websearch') {
      onWebsearchEnabledChange?.(!websearchEnabled);
    }
    // ... handle other menu items
  },
  [/* dependencies */]
);

const { activeIndex: menuActiveIndex } = useKeyboardNavigation(actionsMenuRef, {
  isActive: isOpen,
  onClose: handleActionsMenuClose,
  onSelect: handleMenuItemSelect  // NEW: Added onSelect callback
});
```

### 2. Added Websearch to `menuNavItems` Array

```javascript
const menuNavItems = [];
// ... existing items
if (hasWebsearch) menuNavItems.push('websearch');  // NEW: Added websearch
grouped.forEach(g => menuNavItems.push(`group-${g.id}`));
individual.forEach(id => menuNavItems.push(`tool-${id}`));
```

### 3. Updated Websearch DOM Structure with Proper ARIA and Keyboard Handlers

```javascript
<div
  role="menuitemcheckbox"               // NEW: ARIA role
  aria-checked={websearchEnabled}       // NEW: ARIA state
  tabIndex={navTabIndex('websearch')}   // NEW: Roving tabindex
  className="... focus:ring-2 focus:ring-indigo-500 ..."  // NEW: Focus styling
  onClick={() => onWebsearchEnabledChange?.(!websearchEnabled)}
  onKeyDown={e => {                     // NEW: Keyboard handler
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      onWebsearchEnabledChange?.(!websearchEnabled);
    }
  }}
>
  {/* Content */}
  <label className="... pointer-events-none">  {/* NEW: Prevent double activation */}
    <input type="checkbox" checked={websearchEnabled} tabIndex={-1} />
  </label>
</div>
```

## Key Implementation Details

### Roving TabIndex Pattern

The `useKeyboardNavigation` hook implements the roving tabindex pattern:
- One menu item has `tabIndex={0}` (currently focused)
- All other items have `tabIndex={-1}` (not in tab order)
- Arrow keys move focus between items
- The active item is tracked in the `menuActiveIndex` state

### Keyboard Interaction

- **Tab**: Enters/exits the menu (browser default)
- **Arrow Up/Down**: Navigate between menu items
- **Space or Enter**: Activate the focused item
- **Escape**: Close the menu

### ARIA Attributes

- `role="menuitemcheckbox"`: Identifies this as a checkbox menu item
- `aria-checked={true|false}`: Announces the current state
- Focus ring styling: Provides visual feedback for keyboard users

## Testing

The fix ensures:
1. ✅ Users can tab to the "+" menu button
2. ✅ Arrow keys navigate to the websearch toggle
3. ✅ Space or Enter activates the toggle
4. ✅ Screen readers announce the state change
5. ✅ Visual focus indicator is visible

## Related Code

- `client/src/shared/hooks/useKeyboardNavigation.js` - Keyboard navigation hook
- `client/src/features/chat/components/ChatInputActionsMenu.jsx` - Actions menu component
- Issue #1225 identifies this as a P1 priority fix in the broader WCAG 2.1 AA compliance effort

## WCAG Compliance

This fix addresses:
- **WCAG 2.1.1 Keyboard (Level A)**: All functionality is available via keyboard
- **WCAG 4.1.2 Name, Role, Value (Level A)**: Proper ARIA attributes for assistive technologies

## Future Improvements

Consider applying this same pattern to other interactive elements in the menu that may have similar accessibility issues. The comprehensive accessibility audit in issue #1225 identifies additional areas for improvement.
