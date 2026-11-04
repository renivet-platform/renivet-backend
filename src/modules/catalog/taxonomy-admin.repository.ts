import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { IdentityInfrastructure } from '../identity/identity-infrastructure';
import { CategoryAttributeRule, compileCategorySchema, SUPPORTED_CATEGORY_VALIDATOR_VERSION } from './category-attribute-validator';
import {
  buildCategorySchemaDiff,
  CategorySchemaProposalInput,
  TaxonomyAdminRepository,
  TaxonomyMutationContext,
  CategorySchemaRuleSnapshot,
} from './taxonomy-admin.service';

const ADVISORY_TAXONOMY_LOCK = '56056056';

@Injectable()
export class TaxonomyAdminPostgresRepository implements TaxonomyAdminRepository {
  constructor(private readonly infrastructure: IdentityInfrastructure) {}

  async propose(input: CategorySchemaProposalInput, context: TaxonomyMutationContext): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      await client.query('SELECT pg_catalog.pg_advisory_xact_lock($1::bigint)', [ADVISORY_TAXONOMY_LOCK]);
      const requestHash = hash(input);
      const prior = await this.findIdempotent(client, context, 'propose', requestHash);
      if (prior) return prior;

      const category = await client.query<{ id: string; schema_version: number | null; is_leaf: boolean; retired: boolean }>(
        `SELECT c.id, c.schema_version,
                NOT EXISTS (SELECT 1 FROM catalogue.categories child WHERE child.parent_id=c.id) AS is_leaf,
                (NOT c.active AND EXISTS (SELECT 1 FROM catalogue.category_availability_events e
                                           WHERE e.category_id=c.id AND e.active_after=false)) AS retired
           FROM catalogue.categories c WHERE c.id=$1 FOR UPDATE`,
        [input.categoryId],
      );
      const row = category.rows[0];
      if (!row) throw taxonomyError('TAXONOMY_CATEGORY_NOT_FOUND');
      if (!row.is_leaf || row.retired || input.version !== (row.schema_version ?? 0) + 1) {
        throw taxonomyError('TAXONOMY_VERSION_CONFLICT');
      }
      const labels = await this.assertAttributes(client, input.ruleset.attributes);

      const versionId = randomUUID();
      await client.query(
        `INSERT INTO catalogue.category_schema_versions
           (id, category_id, version, state, ruleset, ruleset_sha256, validator_version)
         VALUES ($1,$2,$3,'DRAFT',$4::jsonb,repeat('0',64),$5)`,
        [versionId, input.categoryId, input.version, JSON.stringify(input.ruleset), input.validatorVersion],
      );
      for (const rule of input.ruleset.attributes) {
        await client.query(
          `INSERT INTO catalogue.category_schema_attribute_rules
             (schema_version_id, attribute_id, attribute_code, display_label, scope_type, value_type, allowed_values,
              unit_code, required_by_default, conditional_ast, min_values, max_values)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::jsonb,$11,$12)`,
          [versionId, rule.attributeId, rule.code, labels.get(rule.attributeId), rule.scope, rule.valueType,
            rule.allowedValues == null ? null : JSON.stringify(rule.allowedValues), rule.unitCode ?? null,
            rule.requiredByDefault ?? false, rule.conditionalAst == null ? null : JSON.stringify(rule.conditionalAst),
            rule.minValues ?? null, rule.maxValues ?? null],
        );
      }
      // REN2-56's insert trigger computes the initial hash. Recompute after the frozen rule rows exist.
      await client.query(`UPDATE catalogue.category_schema_versions SET ruleset=ruleset WHERE id=$1`, [versionId]);

      const previous = row.schema_version === null ? [] : await this.loadRules(client, input.categoryId, row.schema_version);
      const diff = buildCategorySchemaDiff(previous, input.ruleset.attributes.map((rule) => ({
        ...rule, displayLabel: labels.get(rule.attributeId),
      })));
      const receipt = { id: versionId, status: 'draft_submitted', requestId: context.requestId, rowVersion: 1, previewDiff: diff };
      await this.recordEvent(client, context, 'propose', input.categoryId, input.version, requestHash, receipt, diff);
      return receipt;
    }).catch((error: unknown) => { throw normalizeDbError(error); });
  }

  async publish(input: { categoryId: string; version: number }, context: TaxonomyMutationContext): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      await client.query('SELECT pg_catalog.pg_advisory_xact_lock($1::bigint)', [ADVISORY_TAXONOMY_LOCK]);
      const requestHash = hash(input);
      const prior = await this.findIdempotent(client, context, 'publish', requestHash);
      if (prior) return prior;

      const categoryResult = await client.query<{ id: string; schema_version: number | null; is_leaf: boolean; retired: boolean }>(
        `SELECT c.id, c.schema_version,
                NOT EXISTS (SELECT 1 FROM catalogue.categories child WHERE child.parent_id=c.id) AS is_leaf,
                (NOT c.active AND EXISTS (SELECT 1 FROM catalogue.category_availability_events e
                                           WHERE e.category_id=c.id AND e.active_after=false)) AS retired
           FROM catalogue.categories c WHERE c.id=$1 FOR UPDATE`, [input.categoryId],
      );
      const category = categoryResult.rows[0];
      if (!category) throw taxonomyError('TAXONOMY_CATEGORY_NOT_FOUND');
      if (!category.is_leaf || category.retired || input.version !== (category.schema_version ?? 0) + 1) {
        throw taxonomyError('TAXONOMY_VERSION_CONFLICT');
      }

      const versionResult = await client.query<{ id: string; state: string; validator_version: string; ruleset: unknown; ruleset_sha256: string }>(
        `SELECT id, state, validator_version, ruleset, ruleset_sha256
           FROM catalogue.category_schema_versions
          WHERE category_id=$1 AND version=$2 FOR UPDATE`, [input.categoryId, input.version],
      );
      const version = versionResult.rows[0];
      if (!version) throw taxonomyError('TAXONOMY_VERSION_CONFLICT');
      if (version.state !== 'DRAFT' || version.validator_version !== SUPPORTED_CATEGORY_VALIDATOR_VERSION) {
        throw taxonomyError('TAXONOMY_VERSION_CONFLICT');
      }
      const submitter = await client.query<{ actor_user_id: string }>(
        `SELECT actor_user_id FROM catalogue.taxonomy_admin_events
          WHERE category_id=$1 AND schema_version=$2 AND action='propose' ORDER BY occurred_at DESC,id DESC LIMIT 1`,
        [input.categoryId, input.version],
      );
      if (!submitter.rows[0]) throw taxonomyError('CATEGORY_SCHEMA_INVALID');
      if (submitter.rows[0].actor_user_id === context.actorId) throw taxonomyError('TAXONOMY_APPROVER_MUST_DIFFER');
      const rules = await this.loadStoredRules(client, version.id);
      if (!rules.length || !this.matchesRuleset(version.ruleset, rules)) throw taxonomyError('CATEGORY_SCHEMA_INVALID');
      try {
        compileCategorySchema({
          categoryId: input.categoryId,
          categorySchemaVersionId: version.id,
          categorySchemaVersion: input.version,
          validatorVersion: version.validator_version,
          rules,
        });
      } catch {
        throw taxonomyError('CATEGORY_SCHEMA_INVALID');
      }

      await client.query(
        `UPDATE catalogue.category_schema_versions SET state='PUBLISHED', approved_by=$2, published_at=pg_catalog.clock_timestamp()
          WHERE id=$1 AND state='DRAFT'`, [version.id, context.actorId],
      );
      const eventId = randomUUID();
      const payload = {
        categoryId: input.categoryId,
        schemaVersionId: version.id,
        version: input.version,
        rulesetSha256: version.ruleset_sha256,
        approvedBy: context.actorId,
        requestId: context.requestId,
      };
      await client.query(
        `INSERT INTO platform.outbox_events
           (id, aggregate_type, aggregate_id, event_type, event_version, event_payload, event_key)
         VALUES ($1,'category_schema_version',$2,'category_schema.published',1,$3::jsonb,$4)`,
        [eventId, input.categoryId, JSON.stringify(payload), `taxonomy-published:${input.version}:${context.idempotencyKey}`],
      );
      const receipt = { id: eventId, status: 'published', requestId: context.requestId, rowVersion: input.version };
      await this.recordEvent(client, context, 'publish', input.categoryId, input.version, requestHash, receipt, payload);
      return receipt;
    }).catch((error: unknown) => { throw normalizeDbError(error); });
  }

  private async assertAttributes(client: PoolClient, rules: readonly CategorySchemaProposalInput['ruleset']['attributes'][number][]): Promise<Map<string, string>> {
    const ids = rules.map((rule) => rule.attributeId);
    const result = await client.query<{ id: string; code: string; label: string; scope_type: string; value_type: string }>(
      `SELECT id, code, label, scope_type, value_type FROM catalogue.attributes WHERE id=ANY($1::uuid[])`, [ids],
    );
    if (result.rowCount !== ids.length || result.rows.some((row) => {
      const rule = rules.find((item) => item.attributeId === row.id);
      return !rule || row.code !== rule.code || row.scope_type !== rule.scope || row.value_type !== rule.valueType;
    })) throw taxonomyError('CATEGORY_SCHEMA_INVALID');
    return new Map(result.rows.map((row) => [row.id, row.label]));
  }

  private async loadRules(client: PoolClient, categoryId: string, version: number): Promise<CategorySchemaRuleSnapshot[]> {
    const result = await client.query(
      `SELECT r.attribute_code AS code, r.display_label AS "displayLabel", r.scope_type AS scope, r.value_type AS "valueType",
              r.allowed_values AS "allowedValues", r.unit_code AS "unitCode",
              r.required_by_default AS "requiredByDefault", r.conditional_ast AS "conditionalAst",
              r.min_values AS "minValues", r.max_values AS "maxValues"
         FROM catalogue.category_schema_attribute_rules r
         JOIN catalogue.category_schema_versions v ON v.id=r.schema_version_id
        WHERE v.category_id=$1 AND v.version=$2 ORDER BY r.scope_type,r.attribute_code`, [categoryId, version],
    );
    return result.rows;
  }

  private async loadStoredRules(client: PoolClient, versionId: string): Promise<CategoryAttributeRule[]> {
    const result = await client.query(
      `SELECT r.id, r.attribute_id AS "attributeId", r.attribute_code AS code, r.display_label AS "displayLabel",
              r.scope_type AS scope, r.value_type AS "valueType", r.allowed_values AS "allowedValues",
              r.unit_code AS "unitCode", r.required_by_default AS "requiredByDefault",
              r.conditional_ast AS "conditionalAst", r.min_values AS "minValues", r.max_values AS "maxValues"
         FROM catalogue.category_schema_attribute_rules r WHERE r.schema_version_id=$1 ORDER BY r.attribute_code`, [versionId],
    );
    return result.rows;
  }

  private matchesRuleset(stored: unknown, rows: readonly CategoryAttributeRule[]): boolean {
    const value = stored as { attributes?: unknown } | null;
    if (!value || !Array.isArray(value.attributes) || value.attributes.length !== rows.length) return false;
    const storedRules = new Map(value.attributes.map((item) => {
      const rule = item as Record<string, unknown>;
      return [`${rule.scope}:${rule.code}`, rule] as const;
    }));
    return rows.every((row) => {
      const input = storedRules.get(`${row.scope}:${row.code}`);
      if (!input) return false;
      for (const key of ['attributeId', 'code', 'scope', 'valueType', 'allowedValues', 'unitCode', 'requiredByDefault', 'conditionalAst', 'minValues', 'maxValues'] as const) {
        const left = input[key] ?? null;
        const right = row[key] ?? null;
        if (JSON.stringify(left) !== JSON.stringify(right)) return false;
      }
      return true;
    });
  }

  private async findIdempotent(client: PoolClient, context: TaxonomyMutationContext, action: string, requestHash: string): Promise<Record<string, unknown> | null> {
    const result = await client.query<{ payload_hash: string; response_payload: Record<string, unknown> }>(
      `SELECT payload_hash, response_payload FROM catalogue.taxonomy_admin_events
        WHERE actor_user_id=$1 AND idempotency_key=$2 AND action=$3`, [context.actorId, context.idempotencyKey, action],
    );
    const prior = result.rows[0];
    if (!prior) return null;
    if (prior.payload_hash !== requestHash) throw taxonomyError('TAXONOMY_IDEMPOTENCY_CONFLICT');
    return prior.response_payload;
  }

  private async recordEvent(client: PoolClient, context: TaxonomyMutationContext, action: string, categoryId: string, version: number, requestHash: string, response: Record<string, unknown>, metadata: unknown): Promise<void> {
    await client.query(
      `INSERT INTO catalogue.taxonomy_admin_events
         (actor_user_id, action, category_id, schema_version, request_id, idempotency_key, payload_hash, response_payload, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,
      [context.actorId, action, categoryId, version, context.requestId, context.idempotencyKey, requestHash,
        JSON.stringify(response), JSON.stringify(metadata)],
    );
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const pool: Pool | null = this.infrastructure.pool;
    if (!pool) throw Object.assign(new Error('Database unavailable'), { code: 'TAXONOMY_DATABASE_UNAVAILABLE' });
    let client: PoolClient;
    try { client = await pool.connect(); }
    catch { throw Object.assign(new Error('Database unavailable'), { code: 'TAXONOMY_DATABASE_UNAVAILABLE' }); }
    try {
      await client.query('BEGIN');
      const value = await operation(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(sortJson(value))).digest('hex');
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson((value as Record<string, unknown>)[key])]));
}

function taxonomyError(code: string): Error { return Object.assign(new Error(code), { code }); }

function normalizeDbError(error: unknown): unknown {
  const code = (error as { code?: string } | null)?.code;
  if (code === '23505' || code === '40001' || code === '40P01') return taxonomyError('TAXONOMY_VERSION_CONFLICT');
  if (typeof code === 'string' && (code.startsWith('08') || ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', '57P01'].includes(code))) {
    return taxonomyError('TAXONOMY_DATABASE_UNAVAILABLE');
  }
  return error;
}
