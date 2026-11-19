import { Body, ConflictException, Controller, Get, Header, HttpCode, Post, Req, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { ApiCookieAuth, ApiExcludeController } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { IdentityInfrastructure } from './identity-infrastructure';
import { CsrfRejectedError, csrfMatches, readSessionToken, SessionService } from './session.service';

interface ApplicationRequest { headers: Record<string, string | string[] | undefined>; }
const NAME = /^.{3,100}$/u;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * A deliberately narrow, real W1 application handoff:
 * only business and display names are persisted. Evidence, bank verification,
 * PAN/GST and full W2 application revisions must use their separately approved APIs.
 * A pending membership never grants seller workspace access.
 */
@ApiExcludeController()
@ApiCookieAuth('renivetSession')
@Controller('brand-applications')
export class BrandApplicationsController {
  constructor(
    private readonly infrastructure: IdentityInfrastructure,
    private readonly sessions: SessionService,
    private readonly config: ConfigService,
  ) {}

  @Get('mine')
  @Header('Cache-Control', 'no-store')
  async mine(@Req() req: ApplicationRequest): Promise<{items: Record<string, unknown>[]}> {
    const session=await this.sessions.authenticate(readSessionToken(req.headers.cookie));
    const pool=this.infrastructure.pool;
    if(!pool)throw new ServiceUnavailableException({code:'BRAND_APPLICATION_UNAVAILABLE'});
    const found=await pool.query(
      `SELECT b.id AS "brandId",b.display_name AS "brandName",b.legal_name AS "legalName",
             b.onboarding_state AS "brandState",m.membership_state AS "membershipState",
             b.created_at AS "submittedAt"
        FROM brands.brand_memberships m JOIN brands.brands b ON b.id=m.brand_id
       WHERE m.user_id=$1 ORDER BY b.created_at DESC,b.id LIMIT 20`,
      [session.userId]);
    return {items:found.rows};
  }

  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  async apply(@Body() raw: unknown,@Req() req: ApplicationRequest): Promise<Record<string, unknown>> {
    const token=readSessionToken(req.headers.cookie);
    const session=await this.sessions.authenticate(token);
    if(!token || !csrfMatches(req.headers,this.config.get<string[]>('AUTH_ALLOWED_ORIGINS')??[],this.sessions.expectedCsrf(token)))
      throw new CsrfRejectedError();
    if(!raw || typeof raw!=='object'||Array.isArray(raw))
      throw new UnprocessableEntityException({code:'BRAND_APPLICATION_INVALID'});
    const data=raw as Record<string,unknown>;
    if(Object.keys(data).some(k=>!['legalName','brandName'].includes(k)))
      throw new UnprocessableEntityException({code:'BRAND_APPLICATION_INVALID'});
    const legalName=typeof data.legalName==='string'?data.legalName.trim():'';
    const brandName=typeof data.brandName==='string'?data.brandName.trim():'';
    const slug=brandName.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,60).replace(/-+$/g,'');
    if(!NAME.test(legalName)||!NAME.test(brandName)||!SLUG.test(slug))
      throw new UnprocessableEntityException({code:'BRAND_APPLICATION_INVALID',message:'Enter valid business and brand names.'});
    const pool=this.infrastructure.pool;
    if(!pool)throw new ServiceUnavailableException({code:'BRAND_APPLICATION_UNAVAILABLE'});
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[slug]);
      const existing=await client.query<{id:string;legal_name:string;display_name:string;user_id:string|null;membership_state:string|null;onboarding_state:string}>(
        `SELECT b.id,b.legal_name,b.display_name,b.onboarding_state,m.user_id,m.membership_state
           FROM brands.brands b LEFT JOIN brands.brand_memberships m ON m.brand_id=b.id AND m.user_id=$2
          WHERE b.slug=$1 LIMIT 1`,[slug,session.userId]);
      if(existing.rows[0]){
        const entry=existing.rows[0];
        if(entry.user_id!==session.userId||entry.legal_name!==legalName||entry.display_name!==brandName)
          throw new ConflictException({code:'BRAND_APPLICATION_NAME_TAKEN',message:'A brand with this name already exists.'});
        await client.query('COMMIT');
        return {brandId:entry.id,brandName,legalName,brandState:entry.onboarding_state,membershipState:entry.membership_state};
      }
      const count=await client.query<{count:string}>(
        `SELECT count(*)::text AS count FROM brands.brand_memberships m JOIN brands.brands b ON b.id=m.brand_id
           WHERE m.user_id=$1 AND b.onboarding_state='pending'`,[session.userId]);
      if(Number(count.rows[0]?.count??0)>=3)
        throw new ConflictException({code:'BRAND_APPLICATION_LIMIT',message:'You already have three applications awaiting review.'});
      const brand=await client.query<{id:string}>(
        `INSERT INTO brands.brands(slug,legal_name,display_name,onboarding_state,country_code)
         VALUES($1,$2,$3,'pending','IN') RETURNING id`,[slug,legalName,brandName]);
      await client.query(
        `INSERT INTO brands.brand_memberships(brand_id,user_id,membership_state,invited_by_id)
         VALUES($1,$2,'pending',$2)`,[brand.rows[0].id,session.userId]);
      await client.query('COMMIT');
      return {brandId:brand.rows[0].id,brandName,legalName,brandState:'pending',membershipState:'pending'};
    }catch(error){
      await client.query('ROLLBACK').catch(()=>undefined);
      if((error as {code?:string}).code==='23505')
        throw new ConflictException({code:'BRAND_APPLICATION_NAME_TAKEN'});
      throw error;
    }finally{client.release();}
  }
}
