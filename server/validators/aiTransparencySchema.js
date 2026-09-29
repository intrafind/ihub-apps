/**
 * Zod schemas for EU AI Act Art. 50 transparency settings: the platform
 * section `aiTransparency`, the per-app `aiTransparency` block and the
 * per-model `contentMarking` block. Defaults live in
 * `shared/aiTransparency.js`; see `docs/eu-ai-act.md`.
 *
 * @module validators/aiTransparencySchema
 */
import { z } from 'zod';
import {
  DETECTION_ACCESS_LEVELS,
  EXEMPTION_TYPES,
  SENSITIVE_CATEGORIES,
  TEXT_WATERMARK_SCHEMES
} from '../../shared/aiTransparency.js';

/** Art. 50(1) disclosure opt-out (concept §8.2). */
export const disclosureOptOutSchema = z
  .object({
    disabledBy: z.string(),
    disabledByName: z.string().optional(),
    disabledAt: z.string(),
    reason: z.string().min(1),
    installationUrl: z.string().optional(),
    installationId: z.string(),
    ihubVersion: z.string().optional()
  })
  .passthrough();

/** Art. 50(2) exemption declared for an app, with its justification. */
export const exemptionSchema = z
  .object({
    type: z.enum(EXEMPTION_TYPES),
    justification: z.string().min(1),
    declaredBy: z.string(),
    declaredByName: z.string().optional(),
    declaredAt: z.string(),
    installationUrl: z.string().optional(),
    installationId: z.string(),
    ihubVersion: z.string().optional()
  })
  .passthrough();

export const appAiTransparencySchema = z
  .object({
    disclosureOptOut: disclosureOptOutSchema.optional(),
    exemption: exemptionSchema.optional(),
    /** Sensitive context (legal, finance, health, …): periodic reminders. */
    sensitive: z.enum(SENSITIVE_CATEGORIES).optional(),
    /** Overrides the platform reminder interval for this app (0 disables). */
    reminderInterval: z.number().int().min(0).max(100).optional(),
    /** Custom first-turn notice, localized. Empty uses the default text. */
    firstTurnNotice: z.record(z.string(), z.string()).optional(),
    /** App-level override of the text signpost switches. */
    signpost: z
      .object({ exports: z.boolean().optional(), clipboard: z.boolean().optional() })
      .strict()
      .optional()
  })
  .strict();

const upstreamRef = z
  .string()
  .regex(/^upstream:[a-z0-9._-]+$/, 'Use "upstream:<vendor>", e.g. upstream:google');

export const contentMarkingSchema = z
  .object({
    textWatermark: z
      .union([
        z
          .object({
            scheme: z.enum(TEXT_WATERMARK_SCHEMES),
            keyGroup: z
              .string()
              .regex(/^[a-z0-9._-]+$/)
              .optional(),
            /** Send `watermarking: true` per request (vLLM RFC #53916). */
            perRequest: z.boolean().optional()
          })
          .strict(),
        upstreamRef,
        z.literal('none')
      ])
      .optional(),
    imageWatermark: z.union([upstreamRef, z.literal('none')]).optional(),
    notes: z.string().optional(),
    /** Enabling an unmarked model: acknowledgement with justification. */
    acknowledgement: z
      .object({
        acknowledgedBy: z.string(),
        acknowledgedByName: z.string().optional(),
        acknowledgedAt: z.string(),
        justification: z.string().min(1),
        installationUrl: z.string().optional(),
        installationId: z.string(),
        ihubVersion: z.string().optional()
      })
      .passthrough()
      .optional()
  })
  .strict();

const dismissalSchema = z
  .object({
    warningId: z.string(),
    stateHash: z.string(),
    reason: z.string().min(1),
    dismissedBy: z.string(),
    dismissedByName: z.string().optional(),
    dismissedAt: z.string(),
    installationUrl: z.string().optional(),
    installationId: z.string(),
    ihubVersion: z.string().optional()
  })
  .passthrough();

const expertSchema = z
  .object({
    userId: z.string().min(1),
    name: z.string().optional(),
    reason: z.string().optional(),
    approvedBy: z.string().optional(),
    approvedAt: z.string().optional(),
    installationId: z.string().optional()
  })
  .passthrough();

/** `platform.aiTransparency` — prefaults mirror shared DEFAULT_AI_TRANSPARENCY. */
export const aiTransparencyPlatformSchema = z
  .object({
    provider: z
      .object({
        legalEntity: z.string().prefault(''),
        contact: z.string().prefault(''),
        address: z.string().prefault(''),
        role: z.enum(['provider', 'deployer']).prefault('provider')
      })
      .passthrough()
      .prefault({}),
    editorialResponsibility: z
      .object({ contact: z.string().prefault(''), policyUrl: z.string().prefault('') })
      .passthrough()
      .prefault({}),
    termsOfService: z
      .object({ markRemovalClause: z.boolean().prefault(false), url: z.string().prefault('') })
      .passthrough()
      .prefault({}),
    interactionDisclosure: z
      .object({
        enabled: z.boolean().prefault(true),
        firstTurnNotice: z.boolean().prefault(true),
        persistentBadge: z.boolean().prefault(true),
        guardrail: z.boolean().prefault(true),
        reminderInterval: z.number().int().min(0).max(100).prefault(5)
      })
      .passthrough()
      .prefault({}),
    labels: z
      .object({
        messageBadge: z.boolean().prefault(true),
        euIcon: z.enum(['off', 'optional', 'always']).prefault('optional'),
        exportLabel: z.boolean().prefault(true),
        outbound: z.boolean().prefault(true)
      })
      .passthrough()
      .prefault({}),
    images: z
      .object({
        c2pa: z.boolean().prefault(true),
        watermark: z.enum(['trustmark', 'none']).prefault('trustmark'),
        watermarkStrength: z.number().min(0.1).max(1).prefault(0.95),
        trustmarkModelPath: z.string().prefault(''),
        xmp: z.boolean().prefault(true)
      })
      .passthrough()
      .prefault({}),
    text: z
      .object({
        watermarkMinTokens: z.number().int().min(1).prefault(200),
        signpost: z
          .object({
            exports: z.boolean().prefault(true),
            clipboard: z.boolean().prefault(false)
          })
          .passthrough()
          .prefault({}),
        strictMode: z.boolean().prefault(false)
      })
      .passthrough()
      .prefault({}),
    provenance: z
      .object({
        enabled: z.boolean().prefault(true),
        retentionDays: z.number().int().prefault(365)
      })
      .passthrough()
      .prefault({}),
    exports: z
      .object({ sign: z.boolean().prefault(true) })
      .passthrough()
      .prefault({}),
    signing: z
      .object({
        enabled: z.boolean().prefault(true),
        tsaUrl: z.string().prefault(''),
        trustedAnchors: z.array(z.string()).prefault([]),
        organization: z.string().prefault(''),
        commonName: z.string().prefault('')
      })
      .passthrough()
      .prefault({}),
    detection: z
      .object({
        enabled: z.boolean().prefault(true),
        access: z.enum(DETECTION_ACCESS_LEVELS).prefault('authenticated'),
        rateLimit: z
          .object({
            windowMinutes: z.number().int().min(1).prefault(15),
            limit: z.number().int().min(1).prefault(30)
          })
          .passthrough()
          .prefault({}),
        zeroRetention: z.literal(true).prefault(true),
        experts: z.array(expertSchema).prefault([]),
        log: z
          .object({
            enabled: z.boolean().prefault(true),
            retentionDays: z.number().int().prefault(90)
          })
          .passthrough()
          .prefault({})
      })
      .passthrough()
      .prefault({}),
    installationUrl: z.string().prefault(''),
    dismissals: z.array(dismissalSchema).prefault([])
  })
  .passthrough();
