import { z } from 'zod';

export const SCHEMA_VERSION = '1.0.0' as const;
export const SchemaVersionSchema = z.literal(SCHEMA_VERSION);
export const IdSchema = z.uuid().toLowerCase();
export const ChecksumSchema = z.string().regex(/^[a-f0-9]{64}$/, 'Expected lowercase SHA-256 hex');
export const TimestampSchema = z.iso.datetime({ offset: true });
export const CatalogEntryIdSchema = z.string().trim().min(1).max(160);
export const AssistantVersionSchema = z.string().trim().min(1).max(160);
const label = z.string().trim().min(1).max(160);
const labels = z.array(label).max(100).refine(values => new Set(values).size === values.length, 'Duplicate values');
const entryIds = z.array(CatalogEntryIdSchema).max(500).refine(ids => new Set(ids).size === ids.length, 'Duplicate catalog entry IDs');
export const SyntheticTextSchema = z.strictObject({ provenance: z.literal('synthetic'), label, text: z.string().trim().min(1).max(8000) });
export const PracticalConstraintsSchema = z.strictObject({
  partySize: z.number().int().positive().max(10000),
  location: z.strictObject({ city: label, countryCode: z.string().regex(/^[A-Z]{2}$/).optional() }).optional(),
  budgetPerPerson: z.strictObject({ currency: z.string().regex(/^[A-Z]{3}$/), amountMinor: z.number().int().nonnegative().safe() }).optional(),
  dietaryRequirements: labels, accessibilityRequirements: labels, requiredCuisines: labels, excludedEntryIds: entryIds,
});

export const ComparisonExecutionBindingSchema = z.strictObject({
  kind: z.literal('comparison'), comparisonId: IdSchema, caseId: IdSchema,
  suiteVersionId: IdSchema, suiteChecksum: ChecksumSchema, caseChecksum: ChecksumSchema,
  expectationVersionId: IdSchema, expectationChecksum: ChecksumSchema,
  evidenceChecksum: ChecksumSchema, role: z.enum(['baseline', 'candidate']),
  assistantVersion: AssistantVersionSchema, profileId: z.enum(['a', 'b']),
  repeat: z.number().int().min(0).max(2),
});
