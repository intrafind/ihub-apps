# JSON Editor Feature Technical Specification

## Executive Summary

This document provides a comprehensive technical plan for adding JSON editor functionality to the AI Hub Apps frontend, allowing users to switch between form-based editing and raw JSON editing when managing apps, prompts, and models.

## Business Value and User Benefits

- **Power User Access**: Direct JSON manipulation for advanced configurations
- **Missing Field Support**: Access to app configuration fields not exposed in forms
- **Bulk Operations**: Faster editing for users familiar with JSON structure
- **Configuration Import/Export**: Enhanced ability to migrate and share configurations
- **Development Efficiency**: Faster iteration for developers and administrators

## Technical Architecture

### 1. Component Architecture

```
JsonFormEditor (Container)
├── FormView (Existing forms)
├── JsonEditorView (New Monaco-based editor) 
├── ViewToggle (Switch between modes)
├── ValidationPanel (JSON validation feedback)
└── ActionButtons (Save, Cancel, Reset)
```

### 2. Core Components Design

#### JsonFormEditor Container Component
**Location**: `client/src/shared/components/JsonFormEditor.jsx`

```jsx
const JsonFormEditor = ({
  initialData,
  onSave,
  onCancel,
  formComponent: FormComponent,
  validationSchema,
  entityType, // 'app', 'model', 'prompt'
  title,
  subtitle
}) => {
  const [viewMode, setViewMode] = useState('form'); // 'form' | 'json'
  const [formData, setFormData] = useState(initialData);
  const [jsonData, setJsonData] = useState('');
  const [validationErrors, setValidationErrors] = useState([]);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  
  // Sync form data to JSON when switching modes
  // Handle validation and save operations
  // Manage dirty state and confirmation dialogs
}
```

#### JsonEditorView Component
**Location**: `client/src/shared/components/JsonEditorView.jsx`

```jsx
const JsonEditorView = ({
  value,
  onChange,
  validationErrors,
  entityType,
  readOnly = false
}) => {
  // Monaco Editor integration
  // Custom JSON schema for validation
  // Syntax highlighting and auto-completion
  // Error markers and hover tooltips
}
```

#### ViewToggle Component  
**Location**: `client/src/shared/components/ViewToggle.jsx`

```jsx
const ViewToggle = ({
  currentView,
  onViewChange,
  hasUnsavedChanges,
  formIsValid,
  jsonIsValid
}) => {
  // Toggle buttons with visual state indicators
  // Confirmation dialog for unsaved changes
  // Validation status indicators
}
```

### 3. Integration Points

#### Apps Integration
**File**: `client/src/features/admin/pages/AdminAppEditPage.jsx`

Replace the existing form structure with:
```jsx
<JsonFormEditor
  initialData={app}
  onSave={handleSave}
  onCancel={() => navigate('/admin/apps')}
  formComponent={AppEditForm} // Extracted from current JSX
  validationSchema={appValidationSchema}
  entityType="app"
  title={appId === 'new' ? 'Add New App' : 'Edit App'}
/>
```

#### Models Integration
**File**: `client/src/features/admin/pages/AdminModelEditPage.jsx`

Similar integration pattern with model-specific form component and validation.

#### Prompts Integration  
**File**: `client/src/features/admin/pages/AdminPromptEditPage.jsx`

Similar integration pattern with prompt-specific form component and validation.

### 4. Monaco Editor Integration

#### Installation and Setup
Monaco Editor is already installed (`@monaco-editor/react": "^4.7.0`).

#### Configuration
```jsx
import Editor from '@monaco-editor/react';

const JsonEditorView = ({ value, onChange, validationErrors, entityType }) => {
  const editorOptions = {
    minimap: { enabled: false },
    lineNumbers: 'on',
    roundedSelection: false,
    scrollBeyondLastLine: false,
    readOnly: false,
    fontSize: 14,
    tabSize: 2,
    insertSpaces: true,
    automaticLayout: true,
    folding: true,
    bracketMatching: 'always',
    formatOnPaste: true,
    formatOnType: true
  };

  return (
    <Editor
      height="600px"
      defaultLanguage="json"
      value={value}
      onChange={onChange}
      options={editorOptions}
      onMount={handleEditorDidMount}
    />
  );
};
```

#### JSON Schema Integration
```jsx
const handleEditorDidMount = (editor, monaco) => {
  // Configure JSON schema for validation
  monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
    validate: true,
    schemas: [{
      uri: `http://ai-hub-apps.local/${entityType}-schema.json`,
      fileMatch: ['*'],
      schema: getSchemaForEntityType(entityType)
    }]
  });
};
```

## User Experience Flow

### 1. Form to JSON Mode Switch
1. User clicks "JSON View" toggle
2. System validates current form data
3. If invalid, show confirmation dialog with validation errors
4. Convert form data to formatted JSON
5. Display JSON editor with current data
6. Show validation status in sidebar

### 2. JSON to Form Mode Switch  
1. User clicks "Form View" toggle
2. System validates JSON syntax
3. If invalid, show error message and prevent switch
4. Parse JSON and validate against schema
5. Show confirmation if data will be lost (missing form fields)
6. Update form with JSON data
7. Show any validation errors in form

### 3. Save Operation
1. Validate current view data (form or JSON)
2. If JSON mode, parse and validate against schema
3. Show confirmation dialog with summary of changes
4. Submit to existing save endpoints
5. Handle server validation errors
6. Show success/error feedback

### 4. Unsaved Changes Handling
1. Track dirty state in both modes
2. Show unsaved changes indicator
3. Confirm before mode switching with unsaved changes
4. Confirm before navigation with unsaved changes
5. Auto-save to localStorage for recovery

## Data Validation Strategy

### 1. Client-Side Validation

#### JSON Schema Definitions
**Location**: `client/src/schemas/`

```javascript
// appSchema.js
export const appSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', pattern: '^[a-zA-Z0-9-_]+$' },
    name: {
      type: 'object',
      patternProperties: {
        '^[a-z]{2}$': { type: 'string', minLength: 1 }
      },
      additionalProperties: false
    },
    // ... rest of schema based on Zod schema
  },
  required: ['id', 'name', 'description', 'color', 'icon', 'system', 'tokenLimit'],
  additionalProperties: true
};
```

#### Validation Service
**Location**: `client/src/services/validationService.js`

```javascript
export class ValidationService {
  static validateApp(data) {
    // JSON schema validation
    // Business rule validation
    // Return structured errors
  }
  
  static validateModel(data) { /* ... */ }
  static validatePrompt(data) { /* ... */ }
  
  static formatValidationErrors(errors) {
    // Convert to user-friendly messages
    // Map to form fields or JSON paths
  }
}
```

### 2. Server-Side Validation
Utilize existing Zod schemas in `server/validators/` with enhanced error messaging.

### 3. Real-Time Validation
- Monaco Editor: JSON syntax and schema validation
- Form Mode: Field-level validation on blur/change
- JSON Mode: Debounced validation while typing

## Implementation Phases

### Phase 1: Core Infrastructure (Week 1-2)
**Priority**: HIGH

#### Tasks:
1. **Create base components**
   - JsonFormEditor container component
   - ViewToggle component with basic functionality
   - JsonEditorView with Monaco integration

2. **Establish data flow patterns**
   - Form data ↔ JSON conversion utilities
   - State management for mode switching
   - Validation error handling

3. **Basic Monaco configuration**
   - JSON language support
   - Basic editor options
   - Simple validation feedback

#### Deliverables:
- `/client/src/shared/components/JsonFormEditor.jsx`
- `/client/src/shared/components/JsonEditorView.jsx`
- `/client/src/shared/components/ViewToggle.jsx`
- `/client/src/utils/jsonFormUtils.js`

#### Success Criteria:
- Can switch between form and JSON views
- Basic JSON editing functionality works
- Data persists across mode switches

### Phase 2: Validation and Schema Integration (Week 3)
**Priority**: HIGH

#### Tasks:
1. **JSON Schema implementation**
   - Create schemas for apps, models, prompts
   - Integrate with Monaco Editor
   - Client-side validation service

2. **Enhanced validation feedback**
   - Real-time validation in JSON editor
   - Validation error panel
   - Form field error mapping

3. **Data integrity safeguards**
   - Confirmation dialogs for destructive actions
   - Unsaved changes detection
   - Auto-save to localStorage

#### Deliverables:
- `/client/src/schemas/appSchema.js`
- `/client/src/schemas/modelSchema.js`
- `/client/src/schemas/promptSchema.js`
- `/client/src/services/validationService.js`
- `/client/src/shared/components/ValidationPanel.jsx`

#### Success Criteria:
- Real-time JSON validation works
- Schema errors show helpful messages
- No data loss during mode switches

### Phase 3: App Integration (Week 4)
**Priority**: HIGH

#### Tasks:
1. **Extract existing forms**
   - Create reusable AppEditForm component
   - Maintain all existing functionality
   - Preserve form validation logic

2. **Integrate JsonFormEditor**
   - Replace AdminAppEditPage form section
   - Wire up save/cancel handlers
   - Test all app configuration scenarios

3. **Enhanced app-specific features**
   - App schema with inheritance support
   - Variable configuration in JSON mode
   - Tool selection validation

#### Deliverables:
- `/client/src/features/admin/components/AppEditForm.jsx`
- Updated `/client/src/features/admin/pages/AdminAppEditPage.jsx`
- App-specific JSON schema and validation

#### Success Criteria:
- App editing works in both modes
- All existing functionality preserved
- Complex configurations work (variables, tools, etc.)

### Phase 4: Model and Prompt Integration (Week 5)
**Priority**: MEDIUM

#### Tasks:
1. **Extract model and prompt forms**
   - Create ModelEditForm and PromptEditForm components
   - Maintain existing validation and functionality

2. **Integrate with JsonFormEditor**
   - Update model and prompt edit pages
   - Add model/prompt specific schemas
   - Test integration with existing workflows

#### Deliverables:
- `/client/src/features/admin/components/ModelEditForm.jsx`
- `/client/src/features/admin/components/PromptEditForm.jsx`
- Updated model and prompt edit pages
- Model and prompt JSON schemas

#### Success Criteria:
- Model editing works in both modes
- Prompt editing works in both modes
- No regression in existing functionality

### Phase 5: UX Enhancements and Polish (Week 6)
**Priority**: MEDIUM

#### Tasks:
1. **Advanced editor features**
   - JSON formatting and prettification
   - Search and replace in JSON editor
   - JSON diff view for changes

2. **Enhanced user experience**
   - Keyboard shortcuts
   - Better error messages and help text
   - Responsive design improvements

3. **Performance optimizations**
   - Lazy loading of Monaco Editor
   - Debounced validation
   - Optimized re-renders

#### Deliverables:
- Enhanced JsonEditorView with advanced features
- Improved validation messages and help system
- Performance optimizations

#### Success Criteria:
- Editor feels responsive and professional
- Users can efficiently work in JSON mode
- No performance regressions

### Phase 6: Testing and Documentation (Week 7)
**Priority**: LOW

#### Tasks:
1. **Testing coverage**
   - Unit tests for validation service
   - Integration tests for form/JSON switches
   - E2E tests for complete workflows

2. **Documentation**
   - User guide for JSON editing
   - Developer documentation for component APIs
   - Update existing documentation

#### Deliverables:
- Test suite for JSON editor functionality
- User and developer documentation
- Updated README and guides

#### Success Criteria:
- High test coverage for new components
- Clear documentation for users and developers
- Ready for production deployment

## Files to Create/Modify

### New Files:
```
client/src/shared/components/
├── JsonFormEditor.jsx
├── JsonEditorView.jsx
├── ViewToggle.jsx
└── ValidationPanel.jsx

client/src/schemas/
├── appSchema.js
├── modelSchema.js
└── promptSchema.js

client/src/services/
└── validationService.js

client/src/utils/
└── jsonFormUtils.js

client/src/features/admin/components/
├── AppEditForm.jsx
├── ModelEditForm.jsx
└── PromptEditForm.jsx
```

### Modified Files:
```
client/src/features/admin/pages/
├── AdminAppEditPage.jsx
├── AdminModelEditPage.jsx
└── AdminPromptEditPage.jsx

client/package.json (if new dependencies needed)
```

## Technical Challenges and Solutions  

### 1. Challenge: Data Structure Synchronization
**Problem**: Keeping form state and JSON state synchronized across mode switches.

**Solution**:
- Use a single source of truth (JSON data)
- Convert to form-friendly structure for form mode
- Implement bi-directional conversion utilities
- Use React useEffect for sync operations

### 2. Challenge: Validation Complexity
**Problem**: Different validation needs for form vs JSON mode.

**Solution**:
- Create unified validation service
- JSON Schema for structure validation
- Business rule validation layer
- Map validation errors to appropriate UI elements

### 3. Challenge: Large JSON Performance
**Problem**: Large app configurations may cause editor performance issues.

**Solution**:
- Implement virtualization if needed
- Debounce validation calls
- Lazy load editor component
- Optimize JSON parsing/stringifying

### 4. Challenge: Data Loss Prevention
**Problem**: Users may lose work when switching modes or navigating.

**Solution**:
- Unsaved changes detection
- Confirmation dialogs before destructive actions
- Auto-save to localStorage
- Clear visual indicators for dirty state

### 5. Challenge: Complex Form Integration
**Problem**: Existing forms have complex nested state and validation.

**Solution**:
- Extract forms into reusable components
- Maintain existing prop interfaces
- Use composition pattern for integration
- Gradual migration approach

## Security Considerations

### 1. Input Validation
- Server-side validation remains primary defense
- Client-side JSON schema prevents malformed data
- XSS prevention in error messages
- Sanitize user input before display

### 2. Data Integrity
- Validate against known schema structure
- Prevent injection of unknown/dangerous fields
- Maintain audit trail for configuration changes
- Use existing authentication/authorization

### 3. Editor Security
- Monaco Editor is trusted component
- No eval() or dynamic code execution
- Sanitize JSON content before processing
- Standard Content Security Policy compliance

## Performance Considerations

### 1. Bundle Size Impact
- Monaco Editor is already included (~2MB)
- Additional components add minimal size
- Consider code splitting for admin routes
- Lazy load editor component

### 2. Runtime Performance
- Debounce validation during typing
- Optimize JSON parsing for large configs
- Use React memo for expensive components
- Minimize re-renders during editing

### 3. Memory Usage
- Clean up editor instances on unmount
- Avoid memory leaks in validation
- Optimize JSON string manipulation
- Use efficient data structures

## Success Metrics and KPIs

### 1. User Adoption Metrics
- Percentage of admin users trying JSON mode
- Time spent in JSON vs form mode
- User preference settings/feedback
- Feature usage analytics

### 2. Efficiency Metrics  
- Time to complete configuration tasks
- Number of save operations per session
- Validation error rates by mode
- User error recovery success rate

### 3. Technical Metrics
- Component load times
- Validation performance
- Memory usage patterns
- Error rates and crash frequency

### 4. Quality Metrics
- Configuration validation pass rate
- Data integrity maintenance
- User-reported bugs/issues
- Developer productivity impact

## Risk Assessment and Mitigation

### 1. Risk: User Data Loss
**Likelihood**: Medium | **Impact**: High

**Mitigation**:
- Implement auto-save functionality
- Add confirmation dialogs for destructive actions
- Provide data recovery mechanisms
- Extensive testing of edge cases

### 2. Risk: Performance Degradation
**Likelihood**: Low | **Impact**: Medium

**Mitigation**:
- Performance testing with large configurations
- Implement optimization strategies
- Monitor bundle size increases
- Provide fallback mechanisms

### 3. Risk: Complex Integration Issues
**Likelihood**: Medium | **Impact**: Medium

**Mitigation**:
- Gradual rollout approach
- Maintain backward compatibility
- Comprehensive testing strategy
- Clear rollback procedures

### 4. Risk: User Experience Confusion
**Likelihood**: Medium | **Impact**: Low

**Mitigation**:
- Intuitive UI design
- Clear documentation and help text
- User testing and feedback collection
- Progressive disclosure of complexity

## Conclusion

This JSON editor feature will significantly enhance the flexibility and power of the AI Hub Apps admin interface while maintaining the simplicity of form-based editing for casual users. The phased implementation approach ensures minimal risk while delivering value incrementally.

The technical architecture leverages existing patterns and technologies, ensuring consistency with the current codebase. The comprehensive validation strategy maintains data integrity while providing immediate feedback to users.

Success depends on careful attention to user experience design, thorough testing, and gradual rollout with user feedback integration.