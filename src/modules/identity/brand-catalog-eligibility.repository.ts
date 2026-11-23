import { Injectable } from '@nestjs/common';
import { IdentityInfrastructure } from './identity-infrastructure';
import { BrandApprovalOutcome, BrandCatalogEligibilityRepository } from './brand-catalog-eligibility';

@Injectable()
export class BrandCatalogEligibilityPostgresRepository implements BrandCatalogEligibilityRepository {
  constructor(private readonly infrastructure: IdentityInfrastructure) {}

  async listPending(): Promise<Record<string, unknown>[]> {
    const pool = this.infrastructure.pool;
    if (!pool) throw new Error('Brand eligibility database is unavailable');
    const result = await pool.query(`
      SELECT b.id AS "brandId", b.display_name AS "brandName", b.legal_name AS "legalName",
             b.onboarding_state AS "brandState", b.created_at AS "submittedAt",
             m.user_id AS "applicantUserId", u.display_name AS "applicantName",
             u.email AS "applicantEmail", m.membership_state AS "membershipState"
        FROM brands.brands b
        JOIN brands.brand_memberships m ON m.brand_id=b.id AND m.membership_state='pending'
        JOIN identity.users u ON u.id=m.user_id
       WHERE b.onboarding_state='pending'
       ORDER BY b.created_at, b.id`);
    return result.rows as Record<string, unknown>[];
  }

  async applyOutcome(outcome: BrandApprovalOutcome): Promise<Record<string, unknown>> {
    const pool = this.infrastructure.pool;
    if (!pool) throw new Error('Brand eligibility database is unavailable');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const reviewers = await client.query(
        `SELECT user_id FROM access.effective_permissions
          WHERE user_id=ANY($1::uuid[]) AND permission_code='brand_membership.review'
            AND role_code='renivet_admin' AND scope_type='global' AND brand_id IS NULL
          GROUP BY user_id`,
        [[outcome.approvedByUserId, outcome.checkedByUserId]],
      );
      if (reviewers.rowCount !== 2) throw coded('BRAND_APPROVAL_REVIEWER_DENIED');

      const brand = await client.query(
        'SELECT onboarding_state FROM brands.brands WHERE id=$1 FOR UPDATE', [outcome.brandId],
      );
      if (!brand.rows[0]) throw coded('BRAND_NOT_FOUND');
      const previousBrandState = brand.rows[0].onboarding_state as string;

      const existing = await client.query(
        `SELECT brand_id, applicant_user_id, decision, approved_by_user_id, checked_by_user_id,
                previous_brand_state, resulting_brand_state, membership_before, membership_after, occurred_at
           FROM brands.brand_catalog_eligibility_events WHERE event_id=$1`, [outcome.eventId],
      );
      if (existing.rows[0]) {
        const row = existing.rows[0];
        const same = row.brand_id === outcome.brandId && row.applicant_user_id === outcome.applicantUserId
          && row.decision === outcome.decision && row.approved_by_user_id === outcome.approvedByUserId
          && row.checked_by_user_id === outcome.checkedByUserId;
        if (!same) throw coded('BRAND_APPROVAL_EVENT_CONFLICT');
        await client.query('COMMIT');
        return { eventId: outcome.eventId, brandId: outcome.brandId, decision: outcome.decision,
          brandState: row.resulting_brand_state, membershipState: row.membership_after, replayed: true,
          occurredAt: row.occurred_at };
      }

      const targetState = outcome.decision;
      if (previousBrandState !== 'pending' && previousBrandState !== targetState) {
        throw coded('BRAND_STATE_NOT_REVIEWABLE');
      }

      let membershipBefore: string | null = null;
      let membershipAfter: string | null = null;
      if (outcome.decision === 'approved') {
        const membership = await client.query(
          `SELECT membership_state, joined_at FROM brands.brand_memberships
            WHERE brand_id=$1 AND user_id=$2 FOR UPDATE`, [outcome.brandId, outcome.applicantUserId],
        );
        if (!membership.rows[0]) throw coded('BRAND_MEMBERSHIP_REQUIRED');
        membershipBefore = membership.rows[0].membership_state;
        if (membershipBefore === 'pending') {
          await client.query(
            `UPDATE brands.brand_memberships SET membership_state='active', joined_at=clock_timestamp(),
                    updated_at=clock_timestamp(), row_version=row_version+1
              WHERE brand_id=$1 AND user_id=$2 AND membership_state='pending'`,
            [outcome.brandId, outcome.applicantUserId],
          );
          membershipAfter = 'active';
        } else if (membershipBefore === 'active' && membership.rows[0].joined_at) {
          membershipAfter = 'active';
        } else {
          throw coded('BRAND_MEMBERSHIP_NOT_REVIEWABLE');
        }
      }

      if (outcome.decision === 'approved') {
        // The applicant becomes the brand owner only after independent brand
        // approval and active membership; pending applications grant nothing.
        await client.query(
          `INSERT INTO access.role_assignments
             (user_id,role_id,brand_id,scope_type,granted_by_id)
           SELECT $1,r.id,$2,'brand',$3 FROM access.roles r
            WHERE r.role_code='brand_owner' AND r.scope_kind='brand'
           ON CONFLICT (user_id,role_id,brand_id) WHERE brand_id IS NOT NULL DO NOTHING`,
          [outcome.applicantUserId,outcome.brandId,outcome.approvedByUserId],
        );
        const activeOwner = await client.query(
          `SELECT 1 FROM access.role_assignments a
            JOIN access.roles r ON r.id=a.role_id
            WHERE a.user_id=$1 AND a.brand_id=$2 AND a.scope_type='brand'
              AND r.role_code='brand_owner' AND r.scope_kind='brand'
              AND a.active_from<=clock_timestamp()
              AND (a.active_until IS NULL OR a.active_until>clock_timestamp())`,
          [outcome.applicantUserId,outcome.brandId],
        );
        if (!activeOwner.rowCount) throw coded('BRAND_OWNER_ASSIGNMENT_UNAVAILABLE');
      }

      if (previousBrandState === 'pending') {
        await client.query(
          `UPDATE brands.brands SET onboarding_state=$2, updated_at=clock_timestamp(), row_version=row_version+1
            WHERE id=$1 AND onboarding_state='pending'`, [outcome.brandId, targetState],
        );
      }

      const response = { eventId: outcome.eventId, brandId: outcome.brandId, decision: outcome.decision,
        brandState: targetState, membershipState: membershipAfter, replayed: false };
      const payloadHash = await client.query(
        `SELECT encode(sha256(convert_to(jsonb_build_object(
          'eventId',$1::text,'brandId',$2::text,'applicantUserId',$3::text,'decision',$4::text,
          'approvedByUserId',$5::text,'checkedByUserId',$6::text
        )::text,'UTF8')),'hex') AS hash`,
        [outcome.eventId, outcome.brandId, outcome.applicantUserId, outcome.decision,
          outcome.approvedByUserId, outcome.checkedByUserId],
      );
      const audit = await client.query(
        `INSERT INTO brands.brand_catalog_eligibility_events
          (event_id,brand_id,applicant_user_id,decision,approved_by_user_id,checked_by_user_id,
           request_id,payload_sha256,previous_brand_state,resulting_brand_state,membership_before,membership_after,response_payload)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb) RETURNING occurred_at`,
        [outcome.eventId, outcome.brandId, outcome.applicantUserId, outcome.decision,
          outcome.approvedByUserId, outcome.checkedByUserId, outcome.requestId, payloadHash.rows[0].hash,
          previousBrandState, targetState, membershipBefore, membershipAfter, JSON.stringify(response)],
      );
      await client.query('COMMIT');
      return { ...response, occurredAt: audit.rows[0].occurred_at };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      const pgCode = (error as { code?: string } | null)?.code;
      if (pgCode === '23505') throw coded('BRAND_APPROVAL_EVENT_CONFLICT');
      throw error;
    } finally {
      client.release();
    }
  }
}

function coded(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
