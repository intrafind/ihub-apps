// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, expect } from '@jest/globals';
import { validateRegistryConfig } from '../../validators/registryConfigSchema.js';

describe('registryConfigSchema', () => {
  const base = { id: 'reg', name: 'Registry', source: 'https://registry.example/catalog.json' };

  it('does not trust a registry for code unless the admin says so', () => {
    expect(validateRegistryConfig(base).data.trustCode).toBe(false);
    expect(validateRegistryConfig({ ...base, trustCode: true }).data.trustCode).toBe(true);
    expect(validateRegistryConfig({ ...base, trustCode: 'yes' }).success).toBe(false);
  });
});
