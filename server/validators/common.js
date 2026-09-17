import { z } from 'zod';
import { SAFE_ID_PATTERN } from '../utils/pathSecurity.js';

export const zSafeId = z
  .string()
  .regex(
    SAFE_ID_PATTERN,
    'ID must contain only alphanumeric characters, underscores, dots, and hyphens'
  );
