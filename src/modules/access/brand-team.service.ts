import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { IdentityInfrastructure } from '../identity/identity-infrastructure';

export const teamRoles = ['catalogue_editor', 'stock_manager'] as const;
export type TeamRole = typeof teamRoles[number];
export const validTeamRole = (value: unknown): value is TeamRole => teamRoles.some(role => role === value);
export const inviteEmail = (value: unknown) => typeof value === 'string' ? value.trim().toLowerCase() : '';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const forbidden = () => new ForbiddenException({ code: 'TEAM_ACCESS_DENIED', message: 'Team access was not authorized.' });
const unavailable = () => new ServiceUnavailableException({ code: 'TEAM_SERVICE_UNAVAILABLE', message: 'Team service is temporarily unavailable.' });

@Injectable()
export class BrandTeamService {
  constructor(private readonly infra: IdentityInfrastructure) {}

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    if (!this.infra.pool) throw unavailable();
    const client = await this.infra.pool.connect().catch(() => { throw unavailable(); });
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  private async owner(c: PoolClient, brand: string, actor: string, permission: string) {
    const result = await c.query(
      "SELECT 1 FROM access.effective_permissions WHERE user_id=$1 AND brand_id=$2 AND role_code='brand_owner' AND permission_code=$3 LIMIT 1",
      [actor, brand, permission]);
    if (!result.rowCount) throw forbidden();
  }

  private audit(c: PoolClient, actor: string, brand: string, action: string, subject: string) {
    return c.query(
      "INSERT INTO access.security_audit_events(actor_user_id,action,subject_type,subject_id,request_id,payload_hash) VALUES ($1,$2,'brand_team',$3,$4,$5)",
      [actor, action, subject, randomUUID(), hash(brand + ':' + action + ':' + subject)]);
  }

  async list(brand: string, actor: string) {
    return this.tx(async c => {
      await this.owner(c, brand, actor, 'brand_membership.read');
      const members = await c.query(
        "SELECT m.user_id,m.membership_state,u.display_name,u.email, COALESCE(array_agg(DISTINCT r.role_code) FILTER(WHERE r.role_code IS NOT NULL),ARRAY[]::text[]) AS roles FROM brands.brand_memberships m JOIN identity.users u ON u.id=m.user_id LEFT JOIN access.role_assignments a ON a.user_id=m.user_id AND a.brand_id=m.brand_id AND a.scope_type='brand' AND a.active_from<=now() AND (a.active_until IS NULL OR a.active_until>now()) LEFT JOIN access.roles r ON r.id=a.role_id WHERE m.brand_id=$1 AND m.membership_state='active' GROUP BY m.user_id,m.membership_state,u.display_name,u.email ORDER BY COALESCE(u.display_name,u.email,m.user_id::text)", [brand]);
      const invites = await c.query(
        "SELECT id,email,role_code,expires_at,delivery_state FROM brands.team_invitations WHERE brand_id=$1 AND state='pending' AND expires_at>now() AND delivery_state='sent' ORDER BY created_at DESC LIMIT 100", [brand]);
      return {
        items: members.rows.map(m => ({
          userId: m.user_id, memberName: m.display_name || (m.email ? m.email.split('@')[0] : 'Member'),
          email: m.email ?? null, membershipState: m.membership_state, roles: m.roles,
          isSelf: m.user_id === actor, canRemove: m.user_id !== actor && !(m.roles as string[]).includes('brand_owner'),
        })),
        invitations: invites.rows.map(i => ({
          id: i.id, email: i.email, roleCode: i.role_code, state: 'invited', expiresAt: i.expires_at,
        })),
      };
    });
  }

  async createInvite(brand: string, actor: string, rawEmail: unknown, rawRole: unknown) {
    const email = inviteEmail(rawEmail);
    if (!/^[^\s@]{1,64}@[^\s@]{1,255}$/.test(email) || email.length>254 || !validTeamRole(rawRole)) {
      throw new UnprocessableEntityException({ code: 'TEAM_INVITE_INVALID', message: 'Enter an email and available team role.' });
    }
    const token = randomBytes(32).toString('base64url');
    const result = await this.tx(async c => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [brand+':'+email]);
      await this.owner(c, brand, actor, 'brand_membership.invite');
      const member = await c.query(
        "SELECT 1 FROM brands.brand_memberships m JOIN identity.users u ON u.id=m.user_id WHERE m.brand_id=$1 AND u.email=$2 AND m.membership_state='active' LIMIT 1",
        [brand,email]);
      if (member.rowCount) throw new ConflictException({ code: 'TEAM_ALREADY_MEMBER', message: 'This person already has access.' });
      const existing = await c.query(
        "SELECT id,created_at FROM brands.team_invitations WHERE brand_id=$1 AND email=$2 AND state='pending' FOR UPDATE",
        [brand,email]);
      if (existing.rows.length && Date.now()-new Date(existing.rows[0].created_at).getTime()<60000) {
        throw new ConflictException({ code: 'TEAM_INVITE_COOLDOWN', message: 'Wait before resending an invitation.' });
      }
      const query = existing.rows.length
        ? "UPDATE brands.team_invitations SET role_code=$3,token_hash=$4,invited_by_id=$5,created_at=now(),updated_at=now(),expires_at=now()+interval '7 days',delivery_state='pending' WHERE id=$6 RETURNING id,expires_at"
        : "INSERT INTO brands.team_invitations(brand_id,email,role_code,token_hash,invited_by_id,expires_at) VALUES ($1,$2,$3,$4,$5,now()+interval '7 days') RETURNING id,expires_at";
      const args = existing.rows.length
        ? [brand,email,rawRole,hash(token),actor,existing.rows[0].id]
        : [brand,email,rawRole,hash(token),actor];
      const inserted = await c.query(query,args);
      await this.audit(c,actor,brand,'brand_team.invite_created',inserted.rows[0].id);
      return inserted.rows[0];
    });
    return { id: result.id as string, email, roleCode: rawRole, expiresAt: result.expires_at, token };
  }

  async markDelivered(id: string, status: 'sent'|'failed') {
    if (!this.infra.pool) throw unavailable();
    await this.infra.pool.query(
      "UPDATE brands.team_invitations SET delivery_state=$2,updated_at=now() WHERE id=$1 AND state='pending'",
      [id,status]);
  }

  async cancel(brand: string, actor: string, id: string) {
    return this.tx(async c => {
      await this.owner(c,brand,actor,'brand_membership.invite');
      const result = await c.query(
        "UPDATE brands.team_invitations SET state='cancelled',updated_at=now() WHERE id=$1 AND brand_id=$2 AND state='pending' RETURNING id",
        [id,brand]);
      if (!result.rowCount) throw new NotFoundException({ code:'TEAM_INVITE_MISSING', message:'Invitation not found.' });
      await this.audit(c,actor,brand,'brand_team.invite_cancelled',id);
      return { status: 'cancelled' };
    });
  }

  async accept(brand: string, actor: string, token: unknown) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw forbidden();
    return this.tx(async c => {
      const invite = await c.query(
        "SELECT id,email,role_code,invited_by_id FROM brands.team_invitations WHERE brand_id=$1 AND token_hash=$2 AND state='pending' AND delivery_state='sent' AND expires_at>now() FOR UPDATE",
        [brand,hash(token)]);
      if (!invite.rowCount) throw forbidden();
      const { id, email, role_code, invited_by_id } = invite.rows[0];
      const user = await c.query(
        "SELECT email FROM identity.users WHERE id=$1 AND state='active' AND email_verified_at IS NOT NULL",
        [actor]);
      if (!user.rowCount || user.rows[0].email !== email) throw forbidden();
      const hasOwnerRole = await c.query(
        "SELECT 1 FROM access.role_assignments a JOIN access.roles r ON r.id=a.role_id WHERE a.user_id=$1 AND a.brand_id=$2 AND r.role_code='brand_owner' AND (a.active_until IS NULL OR a.active_until>now())",
        [actor,brand]);
      if (hasOwnerRole.rowCount) throw forbidden();
      await c.query(
        "INSERT INTO brands.brand_memberships(brand_id,user_id,membership_state,invited_by_id,joined_at) VALUES($1,$2,'active',$3,now()) ON CONFLICT(user_id,brand_id) DO UPDATE SET membership_state='active',joined_at=now(),valid_from=now(),valid_until=NULL,updated_at=now(),row_version=brands.brand_memberships.row_version+1",
        [brand,actor,invited_by_id]);
      await c.query(
        "UPDATE access.role_assignments SET active_until=now(),updated_at=now(),row_version=row_version+1 WHERE user_id=$1 AND brand_id=$2 AND scope_type='brand' AND (active_until IS NULL OR active_until>now())",
        [actor,brand]);
      await c.query(
        "INSERT INTO access.role_assignments(user_id,role_id,brand_id,scope_type,granted_by_id) SELECT $1,r.id,$2,'brand',$4 FROM access.roles r WHERE r.role_code=$3 AND r.scope_kind='brand' ON CONFLICT(user_id,role_id,brand_id) WHERE brand_id IS NOT NULL DO UPDATE SET active_from=now(),active_until=NULL,updated_at=now(),granted_by_id=EXCLUDED.granted_by_id,row_version=access.role_assignments.row_version+1",
        [actor,brand,role_code,invited_by_id]);
      await c.query("UPDATE brands.team_invitations SET state='accepted',accepted_by_id=$2,accepted_at=now(),updated_at=now() WHERE id=$1",[id,actor]);
      await this.audit(c,actor,brand,'brand_team.invite_accepted',id);
      return { status:'accepted',brandId:brand };
    });
  }

  async revoke(brand: string, actor: string, target: string) {
    if (actor===target) throw forbidden();
    return this.tx(async c => {
      await this.owner(c,brand,actor,'brand_membership.revoke');
      const membership = await c.query(
        "SELECT 1 FROM brands.brand_memberships WHERE brand_id=$1 AND user_id=$2 AND membership_state='active' FOR UPDATE",
        [brand,target]);
      if (!membership.rowCount) throw new NotFoundException({code:'TEAM_MEMBER_MISSING',message:'Member not found.'});
      const owner = await c.query(
        "SELECT 1 FROM access.role_assignments a JOIN access.roles r ON r.id=a.role_id WHERE a.brand_id=$1 AND a.user_id=$2 AND r.role_code='brand_owner' AND (a.active_until IS NULL OR a.active_until>now()) LIMIT 1",
        [brand,target]);
      if (owner.rowCount) throw forbidden();
      await c.query(
        "UPDATE brands.brand_memberships SET membership_state='revoked',valid_until=now(),updated_at=now(),row_version=row_version+1 WHERE brand_id=$1 AND user_id=$2",
        [brand,target]);
      await c.query(
        "UPDATE access.role_assignments SET active_until=now(),updated_at=now(),row_version=row_version+1 WHERE brand_id=$1 AND user_id=$2 AND scope_type='brand' AND (active_until IS NULL OR active_until>now())",
        [brand,target]);
      await this.audit(c,actor,brand,'brand_team.member_revoked',target);
      return { status:'revoked' };
    });
  }
}
