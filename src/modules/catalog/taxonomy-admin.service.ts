import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  CategoryAttributeRule,
  CategorySchemaSnapshot,
  compileCategorySchema,
  SUPPORTED_CATEGORY_VALIDATOR_VERSION,
} from './category-attribute-validator';

export interface TaxonomyRuleInput {
  readonly attributeId: string;
  readonly code: string;
  readonly scope: 'product' | 'variant';
  readonly valueType: CategoryAttributeRule['valueType'];
  readonly allowedValues?: readonly unknown[] | null;
  readonly unitCode?: string | null;
  readonly requiredByDefault?: boolean;
  readonly conditionalAst?: unknown;
  readonly minValues?: number | null;
  readonly maxValues?: number | null;
}

export interface CategorySchemaProposalInput {
  readonly categoryId: string;
  readonly version: number;
  readonly validatorVersion: string;
  readonly ruleset: { readonly attributes: readonly TaxonomyRuleInput[]; readonly [key: string]: unknown };
}

export interface TaxonomyMutationContext {
  readonly actorId: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface TaxonomyAdminRepository {
  propose(input: CategorySchemaProposalInput, context: TaxonomyMutationContext): Promise<Record<string, unknown>>;
  publish(input: { categoryId: string; version: number }, context: TaxonomyMutationContext): Promise<Record<string, unknown>>;
}

export const TAXONOMY_ADMIN_REPOSITORY = Symbol('TAXONOMY_ADMIN_REPOSITORY');

const RULE_FIELDS = new Set([
  'attributeId', 'code', 'scope', 'valueType', 'allowedValues', 'unitCode', 'requiredByDefault',
  'conditionalAst', 'minValues', 'maxValues',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}

function semanticRule(rule: CategorySchemaRuleSnapshot): Record<string, unknown> {
  return {
    code: rule.code,
    displayLabel: rule.displayLabel ?? rule.code,
    scope: rule.scope,
    valueType: rule.valueType,
    allowedValues: rule.allowedValues ?? null,
    unitCode: rule.unitCode ?? null,
    requiredByDefault: rule.requiredByDefault ?? false,
    conditionalAst: rule.conditionalAst ?? null,
    minValues: rule.minValues ?? null,
    maxValues: rule.maxValues ?? null,
  };
}

function canonicalRule(rule: TaxonomyRuleInput): TaxonomyRuleInput {
  return {
    attributeId: rule.attributeId,
    code: rule.code,
    scope: rule.scope,
    valueType: rule.valueType,
    ...(rule.allowedValues == null ? {} : { allowedValues: rule.allowedValues }),
    ...(rule.unitCode == null ? {} : { unitCode: rule.unitCode }),
    requiredByDefault: rule.requiredByDefault ?? false,
    ...(rule.conditionalAst == null ? {} : { conditionalAst: rule.conditionalAst }),
    ...(rule.minValues == null ? {} : { minValues: rule.minValues }),
    ...(rule.maxValues == null ? {} : { maxValues: rule.maxValues }),
  };
}

export function normalizeCategorySchemaProposal(input: CategorySchemaProposalInput): CategorySchemaProposalInput & { readonly rules: readonly CategoryAttributeRule[] } {
  if (!isRecord(input) || !UUID.test(input.categoryId)
    || !Number.isSafeInteger(input.version) || input.version < 1
    || input.validatorVersion !== SUPPORTED_CATEGORY_VALIDATOR_VERSION
    || !isRecord(input.ruleset) || !Array.isArray(input.ruleset.attributes)
    || Object.keys(input.ruleset).some((key) => key !== 'attributes')
    || input.ruleset.attributes.length < 1 || input.ruleset.attributes.length > 512) {
    throw new BadRequestException({ code: 'CATEGORY_SCHEMA_INVALID', message: 'The category schema proposal is invalid.' });
  }
  const rules = input.ruleset.attributes.map((candidate, index) => {
    if (!isRecord(candidate) || Object.keys(candidate).some((key) => !RULE_FIELDS.has(key))
      || typeof candidate.attributeId !== 'string' || !UUID.test(candidate.attributeId)) {
      throw new BadRequestException({ code: 'CATEGORY_SCHEMA_INVALID', message: 'The category schema proposal is invalid.' });
    }
    return {
      id: `proposal-rule-${index}`,
      attributeId: candidate.attributeId,
      code: candidate.code,
      scope: candidate.scope,
      valueType: candidate.valueType,
      allowedValues: candidate.allowedValues,
      unitCode: candidate.unitCode,
      requiredByDefault: candidate.requiredByDefault,
      conditionalAst: candidate.conditionalAst,
      minValues: candidate.minValues,
      maxValues: candidate.maxValues,
    } as CategoryAttributeRule;
  });
  try {
    compileCategorySchema({
      categoryId: input.categoryId,
      categorySchemaVersionId: `proposal-version-${input.version}`,
      categorySchemaVersion: input.version,
      validatorVersion: input.validatorVersion,
      rules,
    } satisfies CategorySchemaSnapshot);
  } catch {
    throw new BadRequestException({ code: 'CATEGORY_SCHEMA_INVALID', message: 'The category schema proposal is invalid.' });
  }
  const normalizedRules = input.ruleset.attributes.map(canonicalRule);
  return {
    categoryId: input.categoryId,
    version: input.version,
    validatorVersion: input.validatorVersion,
    ruleset: { ...input.ruleset, attributes: normalizedRules },
    rules,
  };
}

export interface CategorySchemaRuleSnapshot {
  readonly code: string;
  readonly displayLabel?: string;
  readonly scope: 'product' | 'variant';
  readonly valueType: string;
  readonly allowedValues?: readonly unknown[] | null;
  readonly unitCode?: string | null;
  readonly requiredByDefault?: boolean;
  readonly conditionalAst?: unknown;
  readonly minValues?: number | null;
  readonly maxValues?: number | null;
}

export function buildCategorySchemaDiff(
  before: readonly CategorySchemaRuleSnapshot[],
  after: readonly CategorySchemaRuleSnapshot[],
): { added: CategorySchemaRuleSnapshot[]; removed: CategorySchemaRuleSnapshot[]; changed: Array<{ code: string; scope: string; before: CategorySchemaRuleSnapshot; after: CategorySchemaRuleSnapshot }> } {
  const key = (rule: CategorySchemaRuleSnapshot) => `${rule.scope}:${rule.code}`;
  const previous = new Map(before.map((rule) => [key(rule), rule]));
  const proposed = new Map(after.map((rule) => [key(rule), rule]));
  const added = [...proposed.entries()].filter(([id]) => !previous.has(id)).map(([, rule]) => rule).sort((a, b) => key(a).localeCompare(key(b)));
  const removed = [...previous.entries()].filter(([id]) => !proposed.has(id)).map(([, rule]) => rule).sort((a, b) => key(a).localeCompare(key(b)));
  const changed = [...proposed.entries()].flatMap(([id, rule]) => {
    const old = previous.get(id);
    return old && stable(semanticRule(old)) !== stable(semanticRule(rule))
      ? [{ code: rule.code, scope: rule.scope, before: old, after: rule }]
      : [];
  }).sort((a, b) => `${a.scope}:${a.code}`.localeCompare(`${b.scope}:${b.code}`));
  return { added, removed, changed };
}

@Injectable()
export class TaxonomyAdminService {
  constructor(@Inject(TAXONOMY_ADMIN_REPOSITORY) private readonly repository: TaxonomyAdminRepository) {}

  async propose(input: CategorySchemaProposalInput, context: TaxonomyMutationContext): Promise<Record<string, unknown>> {
    const normalized = normalizeCategorySchemaProposal(input);
    try { return await this.repository.propose(normalized, context); }
    catch (error) { throw mapTaxonomyError(error); }
  }

  async publish(input: { categoryId: string; version: number }, context: TaxonomyMutationContext): Promise<Record<string, unknown>> {
    if (!UUID.test(input.categoryId) || !Number.isSafeInteger(input.version) || input.version < 1) {
      throw new BadRequestException({ code: 'CATEGORY_SCHEMA_INVALID', message: 'The category schema publication is invalid.' });
    }
    try { return await this.repository.publish(input, context); }
    catch (error) {
      if ((error as { code?: string } | null)?.code === 'CATEGORY_SCHEMA_INVALID') {
        throw new UnprocessableEntityException({ code: 'CATEGORY_SCHEMA_INVALID', message: 'The category schema is incomplete or invalid.' });
      }
      throw mapTaxonomyError(error);
    }
  }
}

function mapTaxonomyError(error: unknown): unknown {
  const code = (error as { code?: string } | null)?.code;
  if (code === 'TAXONOMY_VERSION_CONFLICT' || code === 'TAXONOMY_IDEMPOTENCY_CONFLICT' || code === 'TAXONOMY_APPROVER_MUST_DIFFER') {
    return new ConflictException({ code, message: 'The taxonomy version changed or the request conflicts with an earlier operation.' });
  }
  if (code === 'TAXONOMY_CATEGORY_NOT_FOUND') {
    return new NotFoundException({ code, message: 'The requested category was not found.' });
  }
  if (code === 'CATEGORY_SCHEMA_INVALID') {
    return new BadRequestException({ code, message: 'The category schema proposal is invalid.' });
  }
  if (code === 'TAXONOMY_DATABASE_UNAVAILABLE') {
    return new ServiceUnavailableException({ code: 'TAXONOMY_DATABASE_UNAVAILABLE', message: 'Taxonomy administration is temporarily unavailable.' });
  }
  return error;
}
