/**
 * Unit tests for overriddenFields deduplication in AppCreationWizard
 * Verifies that overridden fields are tracked without duplicates
 */

describe('AppCreationWizard - overriddenFields deduplication', () => {
  // Simplified version of the updateAppData function logic
  const updateOverriddenFields = (prevOverriddenFields, updates, templateApp, newData) => {
    const overriddenFields = [];
    Object.keys(updates).forEach(key => {
      if (JSON.stringify(templateApp[key]) !== JSON.stringify(newData[key])) {
        overriddenFields.push(key);
      }
    });
    // Use Set to ensure uniqueness when merging overridden fields
    const uniqueFields = new Set([...(prevOverriddenFields || []), ...overriddenFields]);
    return Array.from(uniqueFields);
  };

  test('should not add duplicate fields when the same field is updated multiple times', () => {
    const templateApp = {
      id: 'template-app',
      name: { en: 'Template App' },
      system: { en: 'You are a helpful assistant' }
    };

    // Simulate multiple updates to the same field
    let overriddenFields = [];
    
    // First update - change name
    let newData = {
      ...templateApp,
      name: { en: 'Updated App' }
    };
    overriddenFields = updateOverriddenFields(
      overriddenFields,
      { name: { en: 'Updated App' } },
      templateApp,
      newData
    );
    
    // Second update - change name again
    newData = {
      ...newData,
      name: { en: 'Updated App v2' }
    };
    overriddenFields = updateOverriddenFields(
      overriddenFields,
      { name: { en: 'Updated App v2' } },
      templateApp,
      newData
    );
    
    // Third update - change name again
    newData = {
      ...newData,
      name: { en: 'Updated App v3' }
    };
    overriddenFields = updateOverriddenFields(
      overriddenFields,
      { name: { en: 'Updated App v3' } },
      templateApp,
      newData
    );

    // Verify that 'name' appears only once
    expect(overriddenFields).toEqual(['name']);
    expect(overriddenFields.length).toBe(1);
  });

  test('should track multiple different fields without duplicates', () => {
    const templateApp = {
      id: 'template-app',
      name: { en: 'Template App' },
      system: { en: 'You are a helpful assistant' },
      preferredTemperature: 0.7
    };

    let overriddenFields = [];
    
    // Update name
    let newData = {
      ...templateApp,
      name: { en: 'Updated App' }
    };
    overriddenFields = updateOverriddenFields(
      overriddenFields,
      { name: { en: 'Updated App' } },
      templateApp,
      newData
    );
    
    // Update system
    newData = {
      ...newData,
      system: { en: 'Updated system prompt' }
    };
    overriddenFields = updateOverriddenFields(
      overriddenFields,
      { system: { en: 'Updated system prompt' } },
      templateApp,
      newData
    );
    
    // Update name again (should not create duplicate)
    newData = {
      ...newData,
      name: { en: 'Updated App v2' }
    };
    overriddenFields = updateOverriddenFields(
      overriddenFields,
      { name: { en: 'Updated App v2' } },
      templateApp,
      newData
    );
    
    // Update temperature
    newData = {
      ...newData,
      preferredTemperature: 0.9
    };
    overriddenFields = updateOverriddenFields(
      overriddenFields,
      { preferredTemperature: 0.9 },
      templateApp,
      newData
    );

    // Verify all fields appear exactly once
    expect(overriddenFields).toContain('name');
    expect(overriddenFields).toContain('system');
    expect(overriddenFields).toContain('preferredTemperature');
    expect(overriddenFields.length).toBe(3);
    
    // Verify no duplicates
    const uniqueFields = new Set(overriddenFields);
    expect(uniqueFields.size).toBe(overriddenFields.length);
  });

  test('should handle localized fields without creating duplicates', () => {
    const templateApp = {
      id: 'template-app',
      name: { en: 'Template App', de: 'Vorlage App' },
      system: { en: 'System prompt', de: 'System Prompt' }
    };

    let overriddenFields = [];
    
    // Update English name
    let newData = {
      ...templateApp,
      name: { en: 'Updated App', de: 'Vorlage App' }
    };
    overriddenFields = updateOverriddenFields(
      overriddenFields,
      { name: { en: 'Updated App', de: 'Vorlage App' } },
      templateApp,
      newData
    );
    
    // Update German name
    newData = {
      ...newData,
      name: { en: 'Updated App', de: 'Aktualisierte App' }
    };
    overriddenFields = updateOverriddenFields(
      overriddenFields,
      { name: { en: 'Updated App', de: 'Aktualisierte App' } },
      templateApp,
      newData
    );
    
    // Update both languages again
    newData = {
      ...newData,
      name: { en: 'Updated App v2', de: 'Aktualisierte App v2' }
    };
    overriddenFields = updateOverriddenFields(
      overriddenFields,
      { name: { en: 'Updated App v2', de: 'Aktualisierte App v2' } },
      templateApp,
      newData
    );

    // Verify 'name' appears only once despite multiple updates
    expect(overriddenFields).toEqual(['name']);
    expect(overriddenFields.length).toBe(1);
  });

  test('should handle empty initial overriddenFields array', () => {
    const templateApp = {
      id: 'template-app',
      name: { en: 'Template App' }
    };

    const newData = {
      ...templateApp,
      name: { en: 'Updated App' }
    };
    
    const overriddenFields = updateOverriddenFields(
      [],
      { name: { en: 'Updated App' } },
      templateApp,
      newData
    );

    expect(overriddenFields).toEqual(['name']);
  });

  test('should handle undefined initial overriddenFields', () => {
    const templateApp = {
      id: 'template-app',
      name: { en: 'Template App' }
    };

    const newData = {
      ...templateApp,
      name: { en: 'Updated App' }
    };
    
    const overriddenFields = updateOverriddenFields(
      undefined,
      { name: { en: 'Updated App' } },
      templateApp,
      newData
    );

    expect(overriddenFields).toEqual(['name']);
  });

  test('should not track fields that match the template', () => {
    const templateApp = {
      id: 'template-app',
      name: { en: 'Template App' },
      system: { en: 'System prompt' }
    };

    const newData = {
      ...templateApp,
      name: { en: 'Template App' }, // Same as template
      system: { en: 'Updated prompt' } // Different from template
    };
    
    const overriddenFields = updateOverriddenFields(
      [],
      { name: { en: 'Template App' }, system: { en: 'Updated prompt' } },
      templateApp,
      newData
    );

    // Only system should be tracked since name matches template
    expect(overriddenFields).toEqual(['system']);
    expect(overriddenFields).not.toContain('name');
  });
});
