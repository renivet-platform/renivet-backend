import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { canonicalizeSnapshot, snapshotSha256 } from './catalog-submission';
import type { DurableEvent, EventHandler } from '../../workers/durable-worker';
import type { WorkerAuthorizationContext } from '../../workers/worker-authorization';
import type { ProductSearchDocument, ProductSearchIndex } from '../../workers/typesense-product-search';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_LIFECYCLE: Readonly<Record<string, string>> = Object.freeze({
  'catalogue.product.published': 'PUBLISH',
  'catalogue.product.restricted': 'RESTRICT',
  'catalogue.product.unpublished': 'UNPUBLISH',
});
const EFFECT = 'catalog.search.project';
const PAYLOAD_KEYS = ['appealReference','brandId','contentSha256','contentVersion','eventId','lifecycleEvent','productId',
  'publicationState','publicationVersion','reasonCode','reviewId','revisionId','payloadSha256'];

type PublicationPayload = Readonly<{
  appealReference: string | null;
  brandId: string;
  contentSha256: string;
  contentVersion: number;
  eventId: string;
  lifecycleEvent: string;
  productId: string;
  publicationState: string;
  publicationVersion: number;
  reasonCode: string;
  reviewId: string;
  revisionId: string;
  payloadSha256: string;
}>;

type ProductPublicationRow = {
  id: string; brand_id: string; publication_state: string; qc_state: string; publication_version: string | number;
  published_revision_id: string | null; published_approval_id: string | null; published_approval_decision: string | null;
  revision_id: string | null; revision_hash: string | null; revision_content_version: number | null; revision_state: string | null;
  review_id: string | null; review_decision: string | null; reviewer_user_id: string | null; submitted_by: string | null;
  content_snapshot: Record<string, unknown> | null;
};

function fail(code: string): Error { return Object.assign(new Error(code), { code }); }

export function parsePublicationProjectionEvent(event: DurableEvent): PublicationPayload {
  const payload = event.eventPayload;
  if (event.eventVersion !== 1 || event.aggregateType !== 'catalogue.product' || !UUID.test(event.aggregateId)
    || !Object.keys(EVENT_LIFECYCLE).includes(event.eventType) || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw fail('CATALOG_PROJECTION_EVENT_INVALID');
  }
  const value = payload as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (keys.length !== PAYLOAD_KEYS.length || keys.some((key, index) => key !== [...PAYLOAD_KEYS].sort()[index])) throw fail('CATALOG_PROJECTION_EVENT_INVALID');
  const lifecycle = EVENT_LIFECYCLE[event.eventType];
  const expectedState = lifecycle === 'PUBLISH' ? 'PUBLISHED' : lifecycle === 'RESTRICT' ? 'RESTRICTED' : 'APPROVED';
  if (!UUID.test(String(value.eventId)) || value.eventId !== event.id || !UUID.test(String(value.productId)) || value.productId !== event.aggregateId
    || !UUID.test(String(value.brandId)) || !UUID.test(String(value.revisionId)) || !UUID.test(String(value.reviewId))
    || value.lifecycleEvent !== lifecycle || value.publicationState !== expectedState
    || !Number.isSafeInteger(value.publicationVersion) || Number(value.publicationVersion) < 1
    || !Number.isSafeInteger(value.contentVersion) || Number(value.contentVersion) < 1
    || typeof value.contentSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.contentSha256)
    || typeof value.reasonCode !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/.test(value.reasonCode)
    || (value.appealReference !== null && (typeof value.appealReference !== 'string' || value.appealReference.length > 256))
    || typeof value.payloadSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.payloadSha256)) throw fail('CATALOG_PROJECTION_EVENT_INVALID');
  const unsigned = { ...value }; delete unsigned.payloadSha256;
  const digest = createHash('sha256').update(canonicalizeSnapshot(unsigned)).digest('hex');
  if (digest !== value.payloadSha256) throw fail('CATALOG_PROJECTION_EVENT_HASH_INVALID');
  return value as PublicationPayload;
}

export function buildProductSearchDocument(input: { productId: string; brandId: string; publicationVersion: number;
  revisionId: string; contentSha256: string; contentSnapshot: Record<string, unknown> }): ProductSearchDocument {
  const snapshot = input.contentSnapshot;
  const product = snapshot.product as Record<string, unknown> | undefined;
  const variants = snapshot.variants;
  if (!product || product.id !== input.productId || product.brandId !== input.brandId || !Array.isArray(variants)
    || typeof product.categoryId !== 'string' || typeof product.styleCode !== 'string'
    || typeof product.title !== 'string' || typeof product.description !== 'string'
    || snapshotSha256(snapshot) !== input.contentSha256) throw fail('CATALOG_PROJECTION_REVISION_INVALID');
  const variantSkus = variants.map((entry) => entry && typeof entry === 'object' ? (entry as Record<string, unknown>).sku : null)
    .filter((sku): sku is string => typeof sku === 'string').sort();
  const attributes = snapshot.attributes && typeof snapshot.attributes === 'object' && !Array.isArray(snapshot.attributes)
    ? snapshot.attributes as Record<string, unknown> : {};
  const searchableText = [product.title, product.description, product.styleCode, ...variantSkus,
    ...Object.values(attributes).flatMap((value) => typeof value === 'string' || typeof value === 'number' ? [String(value)] : [])]
    .join(' ').replace(/\s+/g, ' ').trim();
  return Object.freeze({ id: input.productId, brand_id: input.brandId, publication_version: input.publicationVersion,
    revision_id: input.revisionId, category_id: product.categoryId, style_code: product.styleCode,
    title: product.title, description: product.description, searchable_text: searchableText, variant_skus: variantSkus });
}

export class CatalogSearchProjectionConsumer {
  readonly handler: EventHandler;
  constructor(private readonly search: ProductSearchIndex, consumerId = 'catalog.search_projection') {
    this.handler = {
      consumerId,
      eventTypes: Object.freeze(Object.keys(EVENT_LIFECYCLE)),
      authorization: Object.freeze({ scope: 'brand', purpose: 'catalog.search_projection', effects: Object.freeze([EFFECT]) }),
      handle: (event, transaction, authorization) => this.handle(event, transaction, authorization),
    };
  }

  async handle(event: DurableEvent, transaction: PoolClient, authorization?: WorkerAuthorizationContext): Promise<void> {
    const payload = parsePublicationProjectionEvent(event);
    if (!authorization || authorization.brandId !== payload.brandId || authorization.sourceEventId !== event.id
      || authorization.purpose !== 'catalog.search_projection') throw fail('WORKER_AUTHORIZATION_DENIED');
    const currentResult = await transaction.query<ProductPublicationRow>(
      `SELECT p.id,p.brand_id,p.publication_state,p.qc_state,p.publication_version,p.published_revision_id,
              p.published_approval_id,p.published_approval_decision,r.id AS revision_id,r.content_sha256 AS revision_hash,
              r.content_version AS revision_content_version,r.review_state AS revision_state,r.content_snapshot,
              q.id AS review_id,q.decision AS review_decision,q.reviewer_user_id,r.submitted_by
         FROM catalogue.products p JOIN brands.brands b ON b.id=p.brand_id AND b.onboarding_state='approved'
         LEFT JOIN catalogue.product_revisions r ON r.id=p.published_revision_id AND r.product_id=p.id AND r.brand_id=p.brand_id
         LEFT JOIN catalogue.product_qc_reviews q ON q.id=p.published_approval_id AND q.revision_id=p.published_revision_id
           AND q.product_id=p.id AND q.brand_id=p.brand_id
        WHERE p.id=$1 AND p.brand_id=$2 FOR UPDATE OF p,b`, [payload.productId, payload.brandId]);
    const current = currentResult.rows[0];
    if (!current) throw fail('CATALOG_PROJECTION_SOURCE_NOT_FOUND');
    await authorization.authorizeEffect(EFFECT, current.brand_id);
    const publicationVersion = Number(current.publication_version);
    if (payload.publicationVersion > publicationVersion) throw fail('CATALOG_PROJECTION_EVENT_FROM_FUTURE');
    const priorResult = await transaction.query<{ publication_version: string | number; document_state: string; projected_sha256: string }>(
      `SELECT publication_version,document_state,projected_sha256 FROM catalogue.search_projection_state
        WHERE product_id=$1 AND brand_id=$2 FOR UPDATE`, [current.id, current.brand_id]);
    const prior = priorResult.rows[0];
    if (prior && Number(prior.publication_version) > publicationVersion) return;

    const published = current.publication_state === 'PUBLISHED' && current.qc_state === 'APPROVED'
      && current.published_revision_id === current.revision_id && current.published_approval_id === current.review_id
      && current.published_approval_decision === 'APPROVED' && current.review_decision === 'APPROVED'
      && current.revision_state === 'APPROVED' && current.reviewer_user_id !== current.submitted_by
      && !!current.content_snapshot && current.revision_hash?.trim() === snapshotSha256(current.content_snapshot);
    const document = published ? buildProductSearchDocument({ productId: current.id, brandId: current.brand_id,
      publicationVersion, revisionId: current.revision_id!, contentSha256: current.revision_hash!.trim(), contentSnapshot: current.content_snapshot! }) : null;
    const documentState = document ? 'PUBLISHED' : 'TOMBSTONED';
    const projectionHash = document ? createHash('sha256').update(canonicalizeSnapshot(document)).digest('hex')
      : createHash('sha256').update(canonicalizeSnapshot({ productId: current.id, publicationVersion, state: 'TOMBSTONED' })).digest('hex');
    if (prior && Number(prior.publication_version) === publicationVersion) {
      if (prior.document_state !== documentState || prior.projected_sha256.trim() !== projectionHash) throw fail('CATALOG_PROJECTION_SAME_VERSION_CONFLICT');
      return;
    }

    if (document) await this.search.upsert(document);
    else await this.search.tombstone(current.id);
    await transaction.query(`INSERT INTO catalogue.search_projection_state
      (product_id,brand_id,publication_version,source_event_id,source_event_publication_version,projection_schema_version,document_state,projected_sha256)
      VALUES($1,$2,$3,$4,$5,1,$6,$7)
      ON CONFLICT(product_id) DO UPDATE SET publication_version=EXCLUDED.publication_version,source_event_id=EXCLUDED.source_event_id,
        source_event_publication_version=EXCLUDED.source_event_publication_version,projection_schema_version=1,
        document_state=EXCLUDED.document_state,projected_sha256=EXCLUDED.projected_sha256
      WHERE catalogue.search_projection_state.publication_version<EXCLUDED.publication_version`,
    [current.id, current.brand_id, publicationVersion, event.id, payload.publicationVersion, documentState, projectionHash]);
  }
}

export function createCatalogSearchProjectionHandler(search: ProductSearchIndex, consumerId = 'catalog.search_projection'): EventHandler {
  return new CatalogSearchProjectionConsumer(search, consumerId).handler;
}
