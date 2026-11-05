export const SUPPORTED_CATEGORY_VALIDATOR_VERSION = 'w2-attribute-validator-v1';
const CONDITIONAL_AST_VERSION = 1;
const MAX_AST_DEPTH = 16;
const MAX_AST_NODES = 256;
const MAX_SCHEMA_RULES = 512;
const MAX_ALLOWED_VALUES = 256;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 10_000;

export type AttributeScope = 'product' | 'variant';
export type AttributeValueType = 'text' | 'integer' | 'decimal' | 'boolean' | 'enum' | 'multi_enum' | 'date' | 'measurement';
export type AttributeInput = Record<string, unknown>;

export interface CategoryAttributeRule {
  readonly id: string;
  readonly attributeId: string;
  readonly code: string;
  readonly displayLabel?: string;
  readonly scope: AttributeScope;
  readonly valueType: AttributeValueType;
  readonly allowedValues?: readonly unknown[] | null;
  readonly unitCode?: string | null;
  readonly requiredByDefault?: boolean;
  readonly conditionalAst?: unknown;
  readonly minValues?: number | null;
  readonly maxValues?: number | null;
}

export interface CategorySchemaSnapshot {
  readonly categoryId: string;
  readonly categorySchemaVersionId: string;
  readonly categorySchemaVersion: number;
  readonly validatorVersion: string;
  readonly rules: readonly CategoryAttributeRule[];
}

export interface AttributeValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly ruleId?: string;
}

export interface AttributeValidationResult {
  readonly valid: boolean;
  readonly categoryId: string;
  readonly categorySchemaVersionId: string;
  readonly categorySchemaVersion: number;
  readonly validatorVersion: string;
  readonly normalizedValues: Readonly<Record<AttributeScope, Readonly<Record<string, unknown>>>>;
  readonly issues: readonly AttributeValidationIssue[];
}

export interface AttributeValuesByScope {
  readonly product?: AttributeInput;
  readonly variant?: AttributeInput;
}

export interface CompiledCategorySchema {
  readonly categoryId: string;
  readonly categorySchemaVersionId: string;
  readonly categorySchemaVersion: number;
  readonly validatorVersion: string;
  validate(
    values: AttributeValuesByScope,
    options?: { readonly mode?: 'draft' | 'submission' },
  ): AttributeValidationResult;
}

interface RuleIndexEntry {
  readonly rule: CategoryAttributeRule;
  readonly condition?: (values: ReadonlyMap<string, unknown>) => boolean;
}

type JsonRecord = Record<string, unknown>;

export class CategoryAttributeValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CategoryAttributeValidationError';
  }
}

function fail(code: string, message: string): never {
  throw new CategoryAttributeValidationError(code, message);
}

function isRecord(value: unknown): value is JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: JsonRecord, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function cloneJson(value: unknown): unknown {
  let nodeCount = 0;
  const ancestors = new Set<object>();
  const visit = (current: unknown, depth: number): unknown => {
    nodeCount += 1;
    if (nodeCount > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      fail('CATEGORY_SCHEMA_INVALID', 'JSON input exceeds the supported complexity limit.');
    }
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current;
    if (typeof current === 'number' && Number.isFinite(current)) return current;
    if (Array.isArray(current)) {
      if (ancestors.has(current)) fail('CATEGORY_SCHEMA_INVALID', 'Cyclic JSON values are not supported.');
      ancestors.add(current);
      const result = current.map((entry) => visit(entry, depth + 1));
      ancestors.delete(current);
      return result;
    }
    if (isRecord(current)) {
      if (ancestors.has(current)) fail('CATEGORY_SCHEMA_INVALID', 'Cyclic JSON values are not supported.');
      ancestors.add(current);
      const result: JsonRecord = Object.create(null) as JsonRecord;
      for (const key of Object.keys(current)) result[key] = visit(current[key], depth + 1);
      ancestors.delete(current);
      return result;
    }
    fail('CATEGORY_SCHEMA_INVALID', 'Values must be finite JSON data.');
  };
  return visit(value, 0);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isValidCode(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    && value.trim() === value && ![...value].some((character) => {
      const code = character.codePointAt(0)!;
      return code <= 0x1f || code === 0x7f;
    });
}

function attributePath(scope: AttributeScope, code: string): string {
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(code)
    ? `attributes.${scope}.${code}`
    : `attributes.${scope}[${JSON.stringify(code)}]`;
}

function compareCanonical(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  fail('ATTRIBUTE_VALUE_INVALID', 'Value must be JSON-compatible.');
}

function isValidDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= monthDays[month - 1];
}

function normalizeNumeric20_6(value: unknown): string | null {
  if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))) return null;
  const raw = String(value);
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match) return null;
  const negative = match[1] === '-';
  const integer = match[2].replace(/^0+(?=\d)/, '');
  let fraction = match[3] ?? '';
  if (integer.length > 14 || fraction.length > 6) return null;
  fraction = fraction.replace(/0+$/, '');
  const zero = /^0+$/.test(integer) && fraction.length === 0;
  return `${negative && !zero ? '-' : ''}${integer}${fraction ? `.${fraction}` : ''}`;
}

function validateValue(rule: CategoryAttributeRule, value: unknown): { valid: boolean; normalized?: unknown } {
  switch (rule.valueType) {
    case 'text':
      return typeof value === 'string' ? { valid: true, normalized: value } : { valid: false };
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value)
        ? { valid: true, normalized: value }
        : { valid: false };
    case 'decimal':
      {
        const normalized = normalizeNumeric20_6(value);
        return normalized === null ? { valid: false } : { valid: true, normalized };
      }
    case 'boolean':
      return typeof value === 'boolean' ? { valid: true, normalized: value } : { valid: false };
    case 'enum':
      return typeof value === 'string' ? { valid: true, normalized: value } : { valid: false };
    case 'multi_enum': {
      if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) return { valid: false };
      const normalized = [...value].sort();
      if (new Set(normalized).size !== normalized.length) return { valid: false };
      if (rule.minValues != null && normalized.length < rule.minValues) return { valid: false };
      if (rule.maxValues != null && normalized.length > rule.maxValues) return { valid: false };
      return { valid: true, normalized };
    }
    case 'date':
      return isValidDate(value) ? { valid: true, normalized: value } : { valid: false };
    case 'measurement':
      if (!isRecord(value) || !hasOnlyKeys(value, ['value', 'unitCode'])
        || typeof value.value !== 'number' || !Number.isFinite(value.value)
        || typeof value.unitCode !== 'string' || !rule.unitCode || value.unitCode !== rule.unitCode) {
        return { valid: false };
      }
      return { valid: true, normalized: { value: value.value, unitCode: value.unitCode } };
    default:
      return { valid: false };
  }
}

function validateRuleDefinition(rule: CategoryAttributeRule): void {
  if (!isRecord(rule)
    || !hasOnlyKeys(rule, ['id', 'attributeId', 'code', 'displayLabel', 'scope', 'valueType', 'allowedValues', 'unitCode',
      'requiredByDefault', 'conditionalAst', 'minValues', 'maxValues'])
    || typeof rule.id !== 'string' || rule.id.length === 0
    || typeof rule.attributeId !== 'string' || rule.attributeId.length === 0
    || !isValidCode(rule.code)
    || (rule.displayLabel != null && (typeof rule.displayLabel !== 'string' || rule.displayLabel.length < 1 || rule.displayLabel.length > 200))
    || !['product', 'variant'].includes(rule.scope)
    || !['text', 'integer', 'decimal', 'boolean', 'enum', 'multi_enum', 'date', 'measurement'].includes(rule.valueType)
    || (rule.requiredByDefault != null && typeof rule.requiredByDefault !== 'boolean')
    || (rule.unitCode != null && (typeof rule.unitCode !== 'string' || rule.unitCode.length > 32))
    || (rule.minValues != null && (!Number.isSafeInteger(rule.minValues) || rule.minValues < 0))
    || (rule.maxValues != null && (!Number.isSafeInteger(rule.maxValues) || rule.maxValues < 0))
    || (rule.minValues != null && rule.maxValues != null && rule.maxValues < rule.minValues)) {
    fail('CATEGORY_SCHEMA_INVALID', 'Category schema contains an invalid attribute rule.');
  }

  if ((rule.valueType === 'enum' || rule.valueType === 'multi_enum')
    && (!Array.isArray(rule.allowedValues) || rule.allowedValues.length === 0)) {
    fail('CATEGORY_SCHEMA_INVALID', 'Enum attribute rules require a non-empty allowed-values list.');
  }
  if (rule.allowedValues != null) {
    if (!Array.isArray(rule.allowedValues) || rule.allowedValues.length > MAX_ALLOWED_VALUES) {
      fail('CATEGORY_SCHEMA_INVALID', 'Allowed values must be a bounded list.');
    }
    const seen = new Set<string>();
    for (const allowed of rule.allowedValues) {
      const checkRule = { ...rule, allowedValues: null, minValues: null, maxValues: null };
      const checked = rule.valueType === 'multi_enum'
        ? (typeof allowed === 'string' ? { valid: true, normalized: allowed } : { valid: false })
        : validateValue(checkRule, allowed);
      if (!checked.valid) {
        fail('CATEGORY_SCHEMA_INVALID', 'Allowed value does not match its declared scalar attribute type.');
      }
      const key = canonicalJson(checked.normalized);
      if (seen.has(key)) fail('CATEGORY_SCHEMA_INVALID', 'Allowed-values lists cannot contain duplicates.');
      seen.add(key);
    }
  }
  if ((rule.minValues != null || rule.maxValues != null) && rule.valueType !== 'multi_enum') {
    fail('CATEGORY_SCHEMA_INVALID', 'Cardinality limits are supported only for multi-enum attributes.');
  }
  if (rule.valueType === 'measurement' && !rule.unitCode) {
    fail('CATEGORY_SCHEMA_INVALID', 'Measurement rules require a canonical unit code.');
  }
}

function validateAstLiteral(rule: CategoryAttributeRule, value: unknown): unknown {
  const candidate = validateValue(rule, value);
  if (!candidate.valid) fail('CONDITIONAL_RULE_INVALID', 'Conditional AST literal does not match its field type.');
  if (rule.allowedValues != null) {
    const allowed = Array.isArray(candidate.normalized)
      ? candidate.normalized.every((entry) => rule.allowedValues!.some((choice) => compareCanonical(choice, entry)))
      : rule.allowedValues.some((choice) => compareCanonical(choice, candidate.normalized));
    if (!allowed) fail('CONDITIONAL_RULE_INVALID', 'Conditional AST literal is outside the field vocabulary.');
  }
  return candidate.normalized;
}

function compileCondition(astValue: unknown, fields: ReadonlyMap<string, CategoryAttributeRule>): (values: ReadonlyMap<string, unknown>) => boolean {
  let safeAst: unknown;
  try {
    safeAst = cloneJson(astValue);
  } catch {
    fail('CONDITIONAL_RULE_INVALID', 'Conditional AST must be finite bounded JSON data.');
  }
  if (!isRecord(safeAst) || !hasOnlyKeys(safeAst, ['version', 'root']) || safeAst.version !== CONDITIONAL_AST_VERSION) {
    fail('CONDITIONAL_RULE_INVALID', 'Conditional AST must use the supported versioned {version, root} format.');
  }

  let nodeCount = 0;
  const compileNode = (nodeValue: unknown, depth: number): ((values: ReadonlyMap<string, unknown>) => boolean) => {
    nodeCount += 1;
    if (depth > MAX_AST_DEPTH || nodeCount > MAX_AST_NODES || !isRecord(nodeValue)) {
      fail('CONDITIONAL_RULE_INVALID', 'Conditional AST exceeds the supported complexity limit or has an invalid node.');
    }
    const op = nodeValue.op;
    if (op === 'all' || op === 'any') {
      if (!hasOnlyKeys(nodeValue, ['op', 'args']) || !Array.isArray(nodeValue.args)
        || nodeValue.args.length === 0 || nodeValue.args.length > 64) {
        fail('CONDITIONAL_RULE_INVALID', 'all/any nodes require 1 to 64 child expressions.');
      }
      const children = nodeValue.args.map((child) => compileNode(child, depth + 1));
      return op === 'all'
        ? (values) => children.every((child) => child(values))
        : (values) => children.some((child) => child(values));
    }
    if (op === 'not') {
      if (!hasOnlyKeys(nodeValue, ['op', 'arg'])) fail('CONDITIONAL_RULE_INVALID', 'not nodes accept only one arg.');
      const child = compileNode(nodeValue.arg, depth + 1);
      return (values) => !child(values);
    }
    if (op !== 'eq' && op !== 'in' && op !== 'exists' && op !== 'gte' && op !== 'lte') {
      fail('CONDITIONAL_RULE_INVALID', 'Conditional AST contains an unknown operator.');
    }
    const allowedKeys = op === 'exists' ? ['op', 'field'] : op === 'in' ? ['op', 'field', 'values'] : ['op', 'field', 'value'];
    if (!hasOnlyKeys(nodeValue, allowedKeys) || typeof nodeValue.field !== 'string') {
      fail('CONDITIONAL_RULE_INVALID', 'Conditional AST field expression has an invalid shape.');
    }
    const field = fields.get(nodeValue.field);
    if (!field) fail('CONDITIONAL_RULE_INVALID', 'Conditional AST may reference only declared category attributes.');
    if (op === 'exists') return (values) => values.has(field.code) && values.get(field.code) != null;
    if (op === 'in') {
      if (!Array.isArray(nodeValue.values) || nodeValue.values.length === 0 || nodeValue.values.length > 64) {
        fail('CONDITIONAL_RULE_INVALID', 'in nodes require 1 to 64 values.');
      }
      const candidates = nodeValue.values.map((value) => validateAstLiteral(field, value));
      return (values) => {
        const checked = validateValue(field, values.get(field.code));
        return checked.valid && candidates.some((candidate) => compareCanonical(checked.normalized, candidate));
      };
    }
    if (op === 'gte' || op === 'lte') {
      if (!['integer', 'decimal', 'date', 'measurement'].includes(field.valueType)) {
        fail('CONDITIONAL_RULE_INVALID', 'gte/lte fields must be numeric, date, or measurement attributes.');
      }
      const expected = validateAstLiteral(field, nodeValue.value) as number | string | { value: number; unitCode: string };
      return (values) => {
        const checked = validateValue(field, values.get(field.code));
        if (!checked.valid) return false;
        const actual = checked.normalized;
        if (typeof actual === 'number' && typeof expected === 'number') return op === 'gte' ? actual >= expected : actual <= expected;
        if (typeof actual === 'string' && typeof expected === 'string') return op === 'gte' ? actual >= expected : actual <= expected;
        if (isRecord(actual) && isRecord(expected) && actual.unitCode === expected.unitCode
          && typeof actual.value === 'number' && typeof expected.value === 'number') {
          return op === 'gte' ? actual.value >= expected.value : actual.value <= expected.value;
        }
        return false;
      };
    }
    const expected = validateAstLiteral(field, nodeValue.value);
    return (values) => {
      const checked = validateValue(field, values.get(field.code));
      return checked.valid && compareCanonical(checked.normalized, expected);
    };
  };

  return compileNode(safeAst.root, 1);
}

function makeIssue(code: string, path: string, message: string, ruleId?: string): AttributeValidationIssue {
  return ruleId ? { code, path, message, ruleId } : { code, path, message };
}

export function compileCategorySchema(snapshot: CategorySchemaSnapshot): CompiledCategorySchema {
  if (!isRecord(snapshot) || !hasOnlyKeys(snapshot, ['categoryId', 'categorySchemaVersionId', 'categorySchemaVersion', 'validatorVersion', 'rules'])
    || !isValidCode(snapshot.categoryId) || !isValidCode(snapshot.categorySchemaVersionId)
    || !Number.isSafeInteger(snapshot.categorySchemaVersion) || snapshot.categorySchemaVersion < 1
    || snapshot.validatorVersion !== SUPPORTED_CATEGORY_VALIDATOR_VERSION || !Array.isArray(snapshot.rules)
    || snapshot.rules.length > MAX_SCHEMA_RULES) {
    if (isRecord(snapshot) && snapshot.validatorVersion !== SUPPORTED_CATEGORY_VALIDATOR_VERSION) {
      fail('VALIDATOR_VERSION_UNSUPPORTED', 'Category schema references an unsupported validator version.');
    }
    fail('CATEGORY_SCHEMA_INVALID', 'Category schema snapshot is malformed.');
  }

  const byCode = new Map<string, CategoryAttributeRule>();
  const byScope = new Map<AttributeScope, Map<string, RuleIndexEntry>>([
    ['product', new Map()],
    ['variant', new Map()],
  ]);
  const snapshotRules = snapshot.rules.map((inputRule) => {
    if (!isRecord(inputRule)) fail('CATEGORY_SCHEMA_INVALID', 'Category schema contains an invalid attribute rule.');
    const safeRule: CategoryAttributeRule = Object.freeze({
      ...inputRule,
      allowedValues: inputRule.allowedValues == null ? inputRule.allowedValues : cloneJson(inputRule.allowedValues) as readonly unknown[],
      conditionalAst: inputRule.conditionalAst == null ? inputRule.conditionalAst : cloneJson(inputRule.conditionalAst),
    }) as CategoryAttributeRule;
    validateRuleDefinition(safeRule);
    return safeRule;
  });
  for (const rule of snapshotRules) {
    if (byCode.has(rule.code) || byScope.get(rule.scope)?.has(rule.code)) {
      fail('CATEGORY_SCHEMA_INVALID', 'Attribute codes must be unique within a category schema.');
    }
    byCode.set(rule.code, rule);
  }
  for (const rule of snapshotRules) {
    const condition = rule.conditionalAst == null ? undefined : compileCondition(rule.conditionalAst, byCode);
    byScope.get(rule.scope)?.set(rule.code, { rule, condition });
  }

  const compiledRules: Record<AttributeScope, readonly RuleIndexEntry[]> = {
    product: [...byScope.get('product')!.values()].sort((a, b) => compareStrings(a.rule.code, b.rule.code)),
    variant: [...byScope.get('variant')!.values()].sort((a, b) => compareStrings(a.rule.code, b.rule.code)),
  };
  const categoryId = snapshot.categoryId;
  const categorySchemaVersionId = snapshot.categorySchemaVersionId;
  const categorySchemaVersion = snapshot.categorySchemaVersion;
  const validatorVersion = snapshot.validatorVersion;

  return Object.freeze({
    categorySchemaVersion,
    categoryId,
    categorySchemaVersionId,
    validatorVersion,
    validate(values: AttributeValuesByScope, options: { readonly mode?: 'draft' | 'submission' } = {}): AttributeValidationResult {
      if (!isRecord(options) || !hasOnlyKeys(options, ['mode'])) {
        fail('ATTRIBUTE_INPUT_INVALID', 'Validation options are malformed.');
      }
      const mode = options.mode ?? 'submission';
      if (!isRecord(values) || !hasOnlyKeys(values, ['product', 'variant'])
        || (mode !== 'draft' && mode !== 'submission')) {
        fail('ATTRIBUTE_INPUT_INVALID', 'Attribute values or validation mode are malformed.');
      }
      const scopedValues = values as unknown as JsonRecord;
      const productValues = Object.hasOwn(scopedValues, 'product') ? scopedValues.product : Object.create(null);
      const variantValues = Object.hasOwn(scopedValues, 'variant') ? scopedValues.variant : Object.create(null);
      if (!isRecord(productValues) || !isRecord(variantValues)) {
        fail('ATTRIBUTE_INPUT_INVALID', 'Values for each scope must be an object.');
      }
      const sourceByScope: Record<AttributeScope, AttributeInput> = {
        product: productValues,
        variant: variantValues,
      };
      for (const scope of ['product', 'variant'] as const) {
        if (Object.keys(sourceByScope[scope]).length > MAX_SCHEMA_RULES) {
          fail('ATTRIBUTE_INPUT_INVALID', 'Attribute input exceeds the supported field limit.');
        }
      }
      const rawByCode = new Map<string, unknown>();
      for (const scope of ['product', 'variant'] as const) {
        for (const [code, value] of Object.entries(sourceByScope[scope])) {
          if (value !== undefined) rawByCode.set(code, value);
        }
      }

      const issues: AttributeValidationIssue[] = [];
      const normalizedValues: Record<AttributeScope, Record<string, unknown>> = {
        product: Object.create(null) as Record<string, unknown>,
        variant: Object.create(null) as Record<string, unknown>,
      };
      for (const scope of ['product', 'variant'] as const) {
        const rules = compiledRules[scope];
        const byInputScope = new Map(rules.map(({ rule }) => [rule.code, rule]));
        const otherScope = scope === 'product' ? 'variant' : 'product';
        const otherCodes = new Set(compiledRules[otherScope].map(({ rule }) => rule.code));
        for (const [code, value] of Object.entries(sourceByScope[scope])) {
          if (value === undefined) continue;
          const knownRule = byInputScope.get(code);
          if (!knownRule) {
            const mismatch = otherCodes.has(code);
            issues.push(makeIssue(
              mismatch ? 'ATTRIBUTE_SCOPE_MISMATCH' : 'ATTRIBUTE_NOT_IN_SCHEMA',
              attributePath(scope, code),
              mismatch ? `Attribute '${code}' is declared for ${otherScope} scope.` : 'Attribute is not declared in this category schema.',
            ));
          }
        }
        for (const { rule, condition } of rules) {
          const hasValue = Object.hasOwn(sourceByScope[scope], rule.code);
          const value = hasValue ? sourceByScope[scope][rule.code] : undefined;
          const present = hasValue && value !== undefined && value !== null;
          const required = Boolean(rule.requiredByDefault)
            || Boolean(condition?.(rawByCode));
          const path = attributePath(scope, rule.code);
          if (!present) {
            if (mode === 'submission' && required) {
              issues.push(makeIssue('ATTRIBUTE_REQUIRED', path, `Attribute '${rule.code}' is required for this category schema.`, rule.id));
            }
            continue;
          }
          const result = validateValue(rule, value);
          if (!result.valid || (Array.isArray(rule.allowedValues)
            && (Array.isArray(result.normalized)
              ? !result.normalized.every((entry) => rule.allowedValues!.some((allowed) => compareCanonical(allowed, entry)))
              : !rule.allowedValues.some((allowed) => compareCanonical(allowed, result.normalized))))) {
            issues.push(makeIssue('ATTRIBUTE_VALUE_INVALID', path, `Attribute '${rule.code}' has an invalid value for the pinned schema.`, rule.id));
            continue;
          }
          normalizedValues[scope][rule.code] = result.normalized;
        }
      }
      issues.sort((a, b) => compareStrings(a.path, b.path) || compareStrings(a.code, b.code));
      return {
        valid: issues.length === 0,
        categoryId,
        categorySchemaVersionId,
        categorySchemaVersion,
        validatorVersion,
        normalizedValues,
        issues,
      };
    },
  });
}

export function canonicalizeOptionSignature(options: AttributeInput): string {
  if (!isRecord(options)) {
    fail('OPTION_SIGNATURE_INVALID', 'Option signature axes must be an object.');
  }
  let safeOptions: JsonRecord;
  try {
    safeOptions = cloneJson(options) as JsonRecord;
  } catch {
    fail('OPTION_SIGNATURE_INVALID', 'Option axes must contain finite JSON values only.');
  }
  if (Object.keys(safeOptions).length > 32) fail('OPTION_SIGNATURE_INVALID', 'Option signatures support at most 32 axes.');
  for (const [axis, value] of Object.entries(safeOptions)) {
    if (!isValidCode(axis) || value === undefined || value === null) {
      fail('OPTION_SIGNATURE_INVALID', 'Option axes must have a valid name and a concrete JSON value.');
    }
    try {
      canonicalJson(value);
    } catch {
      fail('OPTION_SIGNATURE_INVALID', 'Option axes must contain finite JSON values only.');
    }
  }
  return canonicalJson(safeOptions);
}
