import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  Req,
  UseFilters,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiExtension,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiServiceUnavailableResponse,
  ApiUnauthorizedResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { RequireGlobalTaxonomyPermission } from '../access/taxonomy-admin.decorator';
import { csrfMatches, CsrfRejectedError, readSessionToken, SessionService } from '../identity/session.service';
import { CategorySchemaProposalDto, TaxonomyActionReceiptDto, TaxonomyErrorDto } from './taxonomy-admin.dto';
import { TaxonomyExceptionFilter } from './taxonomy-exception.filter';
import { TaxonomyAdminService } from './taxonomy-admin.service';

interface TaxonomyRequest {
  id?: string;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}

const proposalValidation = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
  exceptionFactory: () => new BadRequestException({ code: 'CATEGORY_SCHEMA_INVALID', message: 'The category schema proposal is invalid.' }),
});

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,120}$/;

@ApiTags('Catalog')
@Controller('admin/catalog/categories')
@ApiCookieAuth('renivetSession')
@UseFilters(TaxonomyExceptionFilter)
export class TaxonomyAdminController {
  constructor(
    private readonly taxonomy: TaxonomyAdminService,
    private readonly sessions: SessionService,
    private readonly configuration: ConfigService,
  ) {}

  @Post(':categoryId/schema-versions')
  @HttpCode(201)
  @UsePipes(proposalValidation)
  @RequireGlobalTaxonomyPermission('taxonomy.manage')
  @ApiParam({ name: 'categoryId', type: 'string', format: 'uuid' })
  @ApiExtension('x-renivet-permission', 'taxonomy.manage')
  @ApiExtension('x-renivet-guard', 'platform-global-admin')
  @ApiExtension('x-renivet-mfa-required', true)
  @ApiExtension('x-renivet-csrf-policy', 'Require allowlisted Origin, Sec-Fetch-Site and X-CSRF-Token bound to W1 session; same-statement resource permission in W1.')
  @ApiExtension('x-renivet-implementation-wave', 'W2')
  @ApiOperation({
    operationId: 'proposeCategorySchemaVersion',
    summary: 'Submit a versioned category schema draft for approval',
    description: 'Requires the platform-global taxonomy.manage permission, fresh MFA and session-bound CSRF. Creates a draft snapshot and returns its rule diff against the current published version. Linear: REN2-58.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', minLength: 1, maxLength: 120 }, description: 'Stable request key, 1 to 120 safe characters.' })
  @ApiResponse({ status: 201, description: 'Draft schema submitted. Response includes previewDiff for added, removed, and changed rules.', type: TaxonomyActionReceiptDto })
  @ApiBadRequestResponse({ description: 'Invalid versioned schema, conditional AST, idempotency key, or CSRF proof.', type: TaxonomyErrorDto })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid first-party session.', type: TaxonomyErrorDto })
  @ApiForbiddenResponse({ description: 'Global taxonomy permission, fresh MFA, or CSRF check denied.', type: TaxonomyErrorDto })
  @ApiNotFoundResponse({ description: 'Category does not exist.', type: TaxonomyErrorDto })
  @ApiConflictResponse({ description: 'Stale version, retired category, or changed idempotent replay.', type: TaxonomyErrorDto })
  @ApiResponse({ status: 412, description: 'The category current-version pointer no longer matches the proposed version.', type: TaxonomyErrorDto })
  @ApiResponse({ status: 422, description: 'The schema is incomplete or does not compile against the approved validator.', type: TaxonomyErrorDto })
  @ApiServiceUnavailableResponse({ description: 'Authorization or taxonomy database is unavailable.', type: TaxonomyErrorDto })
  @ApiBody({ schema: {
    type: 'object',
    required: ['categoryId', 'version', 'ruleset', 'validatorVersion'],
    properties: {
      categoryId: { type: 'string', format: 'uuid' },
      version: { type: 'integer', minimum: 1 },
      ruleset: { type: 'object' },
      validatorVersion: { type: 'string' },
    },
  } })
  async propose(
    @Param('categoryId') categoryId: string,
    @Body() body: CategorySchemaProposalDto,
    @Req() request: TaxonomyRequest,
  ): Promise<Record<string, unknown>> {
    const context = await this.mutationContext(request, 'propose');
    if (categoryId !== body.categoryId) throw new BadRequestException({ code: 'CATEGORY_SCHEMA_INVALID', message: 'The category schema proposal is invalid.' });
    return this.taxonomy.propose(body, context);
  }

  @Post(':categoryId/schema-versions/:version/publish')
  @HttpCode(200)
  @RequireGlobalTaxonomyPermission('taxonomy.approve')
  @ApiParam({ name: 'categoryId', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'version', schema: { type: 'integer', minimum: 1 } })
  @ApiExtension('x-renivet-permission', 'taxonomy.approve')
  @ApiExtension('x-renivet-guard', 'platform-global-admin')
  @ApiExtension('x-renivet-mfa-required', true)
  @ApiExtension('x-renivet-csrf-policy', 'Require allowlisted Origin, Sec-Fetch-Site and X-CSRF-Token bound to W1 session; same-statement resource permission in W1.')
  @ApiExtension('x-renivet-implementation-wave', 'W2')
  @ApiOperation({
    operationId: 'publishCategorySchemaVersion',
    summary: 'Approve and publish a category schema version',
    description: 'Requires a separate platform-global taxonomy.approve permission, fresh MFA and session-bound CSRF. Uses the category current-version pointer as a compare-and-swap and writes the audit receipt and publication outbox notice atomically. Linear: REN2-58.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', minLength: 1, maxLength: 120 }, description: 'Stable request key, 1 to 120 safe characters.' })
  @ApiResponse({ status: 200, description: 'Schema version published and category current pointer advanced.', type: TaxonomyActionReceiptDto })
  @ApiBadRequestResponse({ description: 'Invalid category or schema version, or invalid CSRF proof.', type: TaxonomyErrorDto })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid first-party session.', type: TaxonomyErrorDto })
  @ApiForbiddenResponse({ description: 'Global approval permission, fresh MFA, or CSRF check denied.', type: TaxonomyErrorDto })
  @ApiNotFoundResponse({ description: 'Category does not exist.', type: TaxonomyErrorDto })
  @ApiConflictResponse({ description: 'Stale, incomplete, retired, or previously published schema version.', type: TaxonomyErrorDto })
  @ApiResponse({ status: 412, description: 'The category current-version pointer no longer matches the requested version.', type: TaxonomyErrorDto })
  @ApiResponse({ status: 422, description: 'The schema is incomplete or does not compile against the approved validator.', type: TaxonomyErrorDto })
  @ApiServiceUnavailableResponse({ description: 'Authorization or taxonomy database is unavailable.', type: TaxonomyErrorDto })
  async publish(
    @Param('categoryId') categoryId: string,
    @Param('version') rawVersion: string,
    @Req() request: TaxonomyRequest,
  ): Promise<Record<string, unknown>> {
    const context = await this.mutationContext(request, 'publish');
    const version = Number(rawVersion);
    if (!Number.isSafeInteger(version) || version < 1) throw new BadRequestException({ code: 'CATEGORY_SCHEMA_INVALID', message: 'The category schema version is invalid.' });
    return this.taxonomy.publish({ categoryId, version }, context);
  }

  private async mutationContext(request: TaxonomyRequest, action: string): Promise<{ actorId: string; requestId: string; idempotencyKey: string }> {
    const idempotencyKey = this.one(request.headers['idempotency-key']);
    if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new BadRequestException({ code: 'CATEGORY_SCHEMA_INVALID', message: 'The request could not be processed.' });
    }
    const token = readSessionToken(request.headers.cookie);
    const session = await this.sessions.authenticate(token);
    const allowedOrigins = this.configuration.get<string[]>('AUTH_ALLOWED_ORIGINS') ?? [];
    if (!csrfMatches(request.headers, allowedOrigins, this.sessions.expectedCsrf(token!))) throw new CsrfRejectedError();
    return { actorId: session.userId, requestId: request.id ?? `${action}:${idempotencyKey}`, idempotencyKey };
  }

  private one(value: string | string[] | undefined): string | undefined {
    return typeof value === 'string' ? value : value?.length === 1 ? value[0] : undefined;
  }
}
