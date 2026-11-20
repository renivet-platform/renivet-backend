import { Body, Controller, ForbiddenException, Get, Param, Post, Req, ServiceUnavailableException, UseGuards, UnprocessableEntityException } from '@nestjs/common';
import { ApiCookieAuth, ApiExtension, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';
import { BrandAccessGuard, BrandAccessRequest, RequireBrandPermission } from './brand-access.guard';
import { BrandTeamService } from './brand-team.service';
import { csrfMatches, readSessionToken, SessionService } from '../identity/session.service';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const denied = () => new ForbiddenException({ code:'TEAM_ACCESS_DENIED', message:'The operation could not be authorized.' });
type TeamRequest = BrandAccessRequest;

@ApiTags('Brand team')
@ApiCookieAuth('renivetSession')
@Controller('brands/:brandId/access')
export class BrandTeamController {
  constructor(private readonly team: BrandTeamService, private readonly sessions: SessionService,
    private readonly config: ConfigService) {}

  private id(value: string) {
    if (!uuid.test(value)) throw new UnprocessableEntityException({code:'TEAM_ID_INVALID',message:'Invalid team identifier.'});
    return value;
  }

  private async verifiedMutation(req: TeamRequest) {
    const token = readSessionToken(req.headers.cookie);
    if (!token) throw denied();
    const session = await this.sessions.authenticate(token);
    const origins = this.config.get<string[]>('AUTH_ALLOWED_ORIGINS') ?? [];
    if (!csrfMatches(req.headers, origins, this.sessions.expectedCsrf(token))) throw denied();
    return session.userId;
  }

  private async sendInvitation(email: string, brandId: string, token: string) {
    const origin = (this.config.get<string[]>('AUTH_ALLOWED_ORIGINS') ?? [])[0];
    if (!origin) throw new ServiceUnavailableException({code:'TEAM_INVITE_DELIVERY_UNAVAILABLE',message:'Invitation delivery is not configured.'});
    const url = new URL('/brands/invitations/accept',origin);
    url.searchParams.set('brandId',brandId);
    url.searchParams.set('token',token);
    const from = this.config.get<string>('RESEND_FROM') || this.config.get<string>('SMTP_FROM');
    const body = 'You were invited to join a brand team on Renivet. Sign in with this verified email address and follow this link within 7 days: '+url.toString()+'\n\nIf you did not expect this invitation, ignore this message.';
    const provider = this.config.get<string>('EMAIL_OTP_PROVIDER');
    if (provider === 'resend') {
      const key = this.config.get<string>('RESEND_API_KEY') ||
        (this.config.get<string>('SMTP_HOST') === 'smtp.resend.com' ? this.config.get<string>('SMTP_PASSWORD') : undefined);
      if (!key || !from) throw new ServiceUnavailableException({code:'TEAM_INVITE_DELIVERY_UNAVAILABLE',message:'Invitation email is not configured.'});
      const response = await fetch('https://api.resend.com/emails', {
        method:'POST', headers:{ Authorization:'Bearer '+key,'Content-Type':'application/json' },
        body:JSON.stringify({from,to:[email],subject:'Your Renivet brand team invitation',text:body}),
        signal:AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new ServiceUnavailableException({code:'TEAM_INVITE_DELIVERY_FAILED',message:'Invitation email could not be delivered.'});
      return;
    }
    const host = this.config.get<string>('SMTP_HOST');
    if (!host || !from) throw new ServiceUnavailableException({code:'TEAM_INVITE_DELIVERY_UNAVAILABLE',message:'Invitation email is not configured.'});
    const username=this.config.get<string>('SMTP_USERNAME'),password=this.config.get<string>('SMTP_PASSWORD');
    const transport=nodemailer.createTransport({
      host,port:this.config.get<number>('SMTP_PORT') ?? 587,secure:this.config.get<boolean>('SMTP_SECURE') ?? false,
      auth:username&&password?{user:username,pass:password}:undefined,
      connectionTimeout:5000,greetingTimeout:5000,socketTimeout:5000,
    });
    try { await transport.sendMail({from,to:email,subject:'Your Renivet brand team invitation',text:body}); }
    finally {transport.close();}
  }

  @Get('team-v2')
  @UseGuards(BrandAccessGuard)
  @RequireBrandPermission('brand_membership.read')
  @ApiExtension('x-renivet-implementation-wave','W1')
  @ApiOperation({ operationId:'getBrandTeamMembersWithInvitations',summary:'Read real brand members and invited staff in owner-friendly presentation' })
  list(@Req() req: TeamRequest) { return this.team.list(req.brandAccess!.brandId,req.brandAccess!.userId); }

  @Post('invitations')
  @UseGuards(BrandAccessGuard)
  @RequireBrandPermission('brand_membership.invite')
  @ApiHeader({name:'x-csrf-token',required:true})
  @ApiExtension('x-renivet-implementation-wave','W1')
  @ApiOperation({operationId:'inviteBrandTeamMember',summary:'Send a seven-day invitation to a limited brand role'})
  async invite(@Req() req: TeamRequest,@Body() body: {email?: string;roleCode?: string}) {
    await this.verifiedMutation(req);
    const created=await this.team.createInvite(req.brandAccess!.brandId,req.brandAccess!.userId,body?.email,body?.roleCode);
    try {
      await this.sendInvitation(created.email,req.brandAccess!.brandId,created.token);
      await this.team.markDelivered(created.id,'sent');
    } catch {
      await this.team.markDelivered(created.id,'failed').catch(()=>undefined);
      throw new ServiceUnavailableException({code:'TEAM_INVITE_DELIVERY_FAILED',message:'Could not send the invitation. Try again shortly.'});
    }
    return {status:'invited',id:created.id,email:created.email,roleCode:created.roleCode,expiresAt:created.expiresAt};
  }

  @Post('invitations/:invitationId/cancel')
  @UseGuards(BrandAccessGuard)
  @RequireBrandPermission('brand_membership.invite')
  @ApiHeader({name:'x-csrf-token',required:true})
  @ApiExtension('x-renivet-implementation-wave','W1')
  @ApiOperation({operationId:'cancelBrandTeamInvitation'})
  async cancel(@Req() req: TeamRequest,@Param('invitationId') invitationId: string) {
    await this.verifiedMutation(req);
    return this.team.cancel(req.brandAccess!.brandId,req.brandAccess!.userId,this.id(invitationId));
  }

  @Post('team/:userId/revoke')
  @UseGuards(BrandAccessGuard)
  @RequireBrandPermission('brand_membership.revoke')
  @ApiHeader({name:'x-csrf-token',required:true})
  @ApiExtension('x-renivet-implementation-wave','W1')
  @ApiOperation({operationId:'revokeBrandTeamMember'})
  async revoke(@Req() req: TeamRequest,@Param('userId') userId: string) {
    await this.verifiedMutation(req);
    return this.team.revoke(req.brandAccess!.brandId,req.brandAccess!.userId,this.id(userId));
  }

  @Post('invitations/accept')
  @ApiHeader({name:'x-csrf-token',required:true})
  @ApiExtension('x-renivet-implementation-wave','W1')
  @ApiOperation({operationId:'acceptBrandTeamInvitation',summary:'Verified invited email accepts scoped role after sign-in'})
  async accept(@Req() req: TeamRequest,@Param('brandId') brandId: string,@Body() body: { token?: string }) {
    const actor=await this.verifiedMutation(req);
    return this.team.accept(this.id(brandId),actor,body?.token);
  }
}
