'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  SUPPORTED_CATEGORY_VALIDATOR_VERSION,
  canonicalizeOptionSignature,
  compileCategorySchema,
} = require('../dist/modules/catalog/category-attribute-validator.js');

function rule(code, valueType, options = {}) {
  return {
    id: `rule-${code}`,
    attributeId: `attribute-${code}`,
    code,
    scope: 'product',
    valueType,
    ...options,
  };
}

function schema(rules, version = 1) {
  return {
    categoryId: 'category-test',
    categorySchemaVersionId: `category-schema-${version}`,
    categorySchemaVersion: version,
    validatorVersion: SUPPORTED_CATEGORY_VALIDATOR_VERSION,
    rules,
  };
}

test('typed category attributes accept supported scalar, collection, date, enum and measurement values', () => {
  const compiled = compileCategorySchema(schema([
    rule('name', 'text'),
    rule('count', 'integer'),
    rule('precision', 'decimal'),
    rule('weight', 'decimal'),
    rule('featured', 'boolean'),
    rule('color', 'enum', { allowedValues: ['blue', 'red'] }),
    rule('care', 'multi_enum', { allowedValues: ['handwash', 'machine'], minValues: 1, maxValues: 2 }),
    rule('launchDate', 'date'),
    rule('length', 'measurement', { unitCode: 'cm' }),
  ]));

  const result = compiled.validate({ product: {
    name: 'Cotton shirt', count: 2, weight: 1.25, featured: true, color: 'blue',
    care: ['machine', 'handwash'], launchDate: '2026-11-03', length: { value: 42.5, unitCode: 'cm' },
  } });
  assert.equal(result.valid, true);
  assert.deepEqual(result.issues, []);
  assert.equal(result.categorySchemaVersion, 1);
  assert.equal(result.categorySchemaVersionId, 'category-schema-1');
  assert.equal(result.categoryId, 'category-test');
  assert.equal(result.validatorVersion, SUPPORTED_CATEGORY_VALIDATOR_VERSION);
  assert.deepEqual(result.normalizedValues.product.care, ['handwash', 'machine']);
});

test('invalid typed values, units, enum entries, cardinality and dates return stable field paths', () => {
  const compiled = compileCategorySchema(schema([
    rule('count', 'integer'),
    rule('precision', 'decimal'),
    rule('color', 'enum', { allowedValues: ['blue', 'red'] }),
    rule('care', 'multi_enum', { allowedValues: ['handwash', 'machine'], minValues: 1, maxValues: 1 }),
    rule('launchDate', 'date'),
    rule('length', 'measurement', { unitCode: 'cm' }),
  ]));

  const result = compiled.validate({ product: {
    count: 1.5,
    precision: 1.1234567,
    color: 'green',
    care: ['machine', 'machine'],
    launchDate: '2026-02-30',
    length: { value: 42, unitCode: 'in' },
  } });
  assert.equal(result.valid, false);
  assert.deepEqual(result.issues.map(({ path }) => path), [
    'attributes.product.care',
    'attributes.product.color',
    'attributes.product.count',
    'attributes.product.launchDate',
    'attributes.product.length',
    'attributes.product.precision',
  ]);
  assert.deepEqual(result.issues.map(({ code }) => code), [
    'ATTRIBUTE_VALUE_INVALID', 'ATTRIBUTE_VALUE_INVALID', 'ATTRIBUTE_VALUE_INVALID',
    'ATTRIBUTE_VALUE_INVALID', 'ATTRIBUTE_VALUE_INVALID', 'ATTRIBUTE_VALUE_INVALID',
  ]);
});

test('product and variant values are validated only against rules frozen for that scope', () => {
  const compiled = compileCategorySchema(schema([
    rule('material', 'enum', { allowedValues: ['cotton'], scope: 'product' }),
    rule('size', 'enum', { allowedValues: ['S', 'M'], scope: 'variant' }),
  ]));
  const result = compiled.validate({ product: { size: 'M' }, variant: { material: 'cotton' } });
  assert.deepEqual(result.issues.map(({ code, path }) => [code, path]), [
    ['ATTRIBUTE_SCOPE_MISMATCH', 'attributes.product.size'],
    ['ATTRIBUTE_SCOPE_MISMATCH', 'attributes.variant.material'],
  ]);
});

test('default requiredness is enforced for submission and omitted for incomplete drafts', () => {
  const compiled = compileCategorySchema(schema([
    rule('material', 'text', { requiredByDefault: true }),
  ]));
  assert.deepEqual(compiled.validate({ product: {} }).issues.map(({ code, path }) => [code, path]), [
    ['ATTRIBUTE_REQUIRED', 'attributes.product.material'],
  ]);
  assert.equal(compiled.validate({ product: {} }, { mode: 'draft' }).valid, true);
});

test('versioned conditional AST enforces only the pinned schema and preserves older schema behavior', () => {
  const v1 = compileCategorySchema(schema([
    rule('productType', 'enum', { allowedValues: ['shirt', 'trouser', 'top', 'tunic'] }),
    rule('sleeveLength', 'measurement', { unitCode: 'cm' }),
  ], 1));
  const v2 = compileCategorySchema(schema([
    rule('productType', 'enum', { allowedValues: ['shirt', 'trouser'] }),
    rule('sleeveLength', 'measurement', {
      unitCode: 'cm',
      conditionalAst: {
        version: 1,
        root: { op: 'eq', field: 'productType', value: 'shirt' },
      },
    }),
  ], 2));

  const oldRevision = { product: { productType: 'shirt' } };
  assert.equal(v1.validate(oldRevision).valid, true);
  assert.equal(v1.validate(oldRevision).categorySchemaVersion, 1);
  const newRevision = v2.validate(oldRevision);
  assert.equal(newRevision.valid, false);
  assert.equal(newRevision.categorySchemaVersion, 2);
  assert.equal(newRevision.categorySchemaVersionId, 'category-schema-2');
  assert.deepEqual(newRevision.issues.map(({ code, path }) => [code, path]), [
    ['ATTRIBUTE_REQUIRED', 'attributes.product.sleeveLength'],
  ]);
  assert.equal(v2.validate({ product: { productType: 'shirt', sleeveLength: { value: 42, unitCode: 'cm' } } }).valid, true);
  assert.equal(v2.validate({ product: { productType: 'trouser' } }).valid, true);
  assert.equal(v2.validate({ product: { productType: 'shirt' } }, { mode: 'draft' }).valid, true,
    'draft writes may be incomplete; submission mode enforces conditional requiredness');
});

test('conditional AST supports all, any, not, eq, in, exists, gte and lte', () => {
  const compiled = compileCategorySchema(schema([
    rule('productType', 'enum', { allowedValues: ['shirt', 'trouser', 'top', 'tunic'] }),
    rule('age', 'integer'),
    rule('sleeveLength', 'measurement', {
      unitCode: 'cm',
      conditionalAst: {
        version: 1,
        root: { op: 'all', args: [
          { op: 'any', args: [
            { op: 'eq', field: 'productType', value: 'shirt' },
            { op: 'in', field: 'productType', values: ['top', 'tunic'] },
          ] },
          { op: 'not', arg: { op: 'eq', field: 'productType', value: 'trouser' } },
          { op: 'exists', field: 'age' },
          { op: 'gte', field: 'age', value: 18 },
          { op: 'lte', field: 'age', value: 120 },
        ] },
      },
    }),
  ]));
  assert.equal(compiled.validate({ product: { productType: 'shirt', age: 20 } }).valid, false);
  assert.equal(compiled.validate({ product: { productType: 'top', age: 20 } }).valid, false,
    'the in operator is evaluated for declared vocabulary values');
  assert.equal(compiled.validate({ product: { productType: 'shirt', age: 20, sleeveLength: { value: 42, unitCode: 'cm' } } }).valid, true);
  assert.equal(compiled.validate({ product: { productType: 'shirt', age: 130 } }).valid, true,
    'gte/lte predicates bound condition activation; they do not silently impose value ranges');
});

test('conditional comparisons use normalized multi-enum set values', () => {
  const compiled = compileCategorySchema(schema([
    rule('care', 'multi_enum', { allowedValues: ['handwash', 'machine'] }),
    rule('careInstructions', 'text', {
      conditionalAst: {
        version: 1,
        root: { op: 'eq', field: 'care', value: ['machine', 'handwash'] },
      },
    }),
  ]));
  assert.equal(compiled.validate({ product: { care: ['handwash', 'machine'] } }).issues[0].code, 'ATTRIBUTE_REQUIRED');
  assert.equal(compiled.validate({ product: {
    care: ['machine', 'handwash'], careInstructions: 'Wash gently',
  } }).valid, true);
});

test('unknown, malformed, unbounded and out-of-namespace ASTs fail closed at compile time', () => {
  for (const conditionalAst of [
    { version: 1, root: { op: 'exec', source: 'return true' } },
    { version: 2, root: { op: 'exists', field: 'productType' } },
    { version: 1, root: { op: 'exists', field: 'otherCategory.secret' } },
    { version: 1, root: { op: 'all', args: [] } },
    { version: 1, root: { op: 'all', args: Array.from({ length: 70 }, () => ({ op: 'exists', field: 'productType' })) } },
    { version: 1, root: { op: 'gte', field: 'productType', value: 'shirt' } },
    { version: 1, root: { op: 'exists', field: 'productType', sql: 'select 1' } },
  ]) {
    assert.throws(() => compileCategorySchema(schema([
      rule('productType', 'enum', { allowedValues: ['shirt'] }),
      rule('sleeveLength', 'measurement', { unitCode: 'cm', conditionalAst }),
    ])), (error) => error.code === 'CONDITIONAL_RULE_INVALID');
  }
});

test('unsupported validator versions and malformed schema snapshots fail closed', () => {
  assert.throws(() => compileCategorySchema({ ...schema([]), validatorVersion: 'unregistered-v9' }),
    (error) => error.code === 'VALIDATOR_VERSION_UNSUPPORTED');
  assert.throws(() => compileCategorySchema(schema([
    rule('duplicate', 'text'), rule('duplicate', 'text', { scope: 'variant' }),
  ])), (error) => error.code === 'CATEGORY_SCHEMA_INVALID');
});

test('compiled validators isolate themselves from later caller mutation of a schema snapshot', () => {
  const allowedValues = ['shirt'];
  const condition = { version: 1, root: { op: 'eq', field: 'productType', value: 'shirt' } };
  const compiled = compileCategorySchema(schema([
    rule('productType', 'enum', { allowedValues }),
    rule('sleeveLength', 'measurement', { unitCode: 'cm', conditionalAst: condition }),
  ]));
  allowedValues.push('trouser');
  condition.root.value = 'trouser';
  assert.equal(compiled.validate({ product: { productType: 'trouser' } }).valid, false,
    'the compiled vocabulary and AST must remain frozen to the source snapshot');
  assert.equal(compiled.validate({ product: { productType: 'shirt' } }).issues[0].code, 'ATTRIBUTE_REQUIRED');
});

test('option signatures are deterministic over axis order and reject invalid axes', () => {
  assert.equal(canonicalizeOptionSignature({ color: 'blue', size: 'M' }),
    canonicalizeOptionSignature({ size: 'M', color: 'blue' }));
  assert.equal(canonicalizeOptionSignature({}), '{}', 'a no-option variant still has a stable non-empty signature');
  assert.notEqual(canonicalizeOptionSignature({ color: 'blue', size: 'M' }),
    canonicalizeOptionSignature({ color: 'blue', size: 'L' }));
  assert.throws(() => canonicalizeOptionSignature({ '': 'M' }), (error) => error.code === 'OPTION_SIGNATURE_INVALID');
  assert.throws(() => canonicalizeOptionSignature({ size: undefined }), (error) => error.code === 'OPTION_SIGNATURE_INVALID');
  const unknown = compileCategorySchema(schema([rule('known', 'text')])).validate({ product: { 'bad.path': 'value' } });
  assert.equal(unknown.issues[0].path, 'attributes.product["bad.path"]');
  const compiled = compileCategorySchema(schema([]));
  assert.throws(() => compiled.validate({ unexpectedScope: {} }),
    (error) => error.code === 'ATTRIBUTE_INPUT_INVALID');
  assert.throws(() => compiled.validate({ product: null }),
    (error) => error.code === 'ATTRIBUTE_INPUT_INVALID');
  assert.throws(() => compiled.validate({}, { mode: 'preview' }),
    (error) => error.code === 'ATTRIBUTE_INPUT_INVALID');
});
