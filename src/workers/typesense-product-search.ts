export type ProductSearchDocument = Readonly<{
  id: string;
  brand_id: string;
  publication_version: number;
  revision_id: string;
  category_id: string;
  style_code: string;
  title: string;
  description: string;
  searchable_text: string;
  variant_skus: readonly string[];
}>;

export interface ProductSearchIndex {
  upsert(document: ProductSearchDocument): Promise<void>;
  tombstone(productId: string): Promise<void>;
}

export type TypesenseProductSearchConfig = Readonly<{
  url: string;
  apiKey: string;
  collection: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}>;

export class TypesenseProductSearchClient implements ProductSearchIndex {
  private readonly baseUrl: URL;
  private readonly requestFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly config: TypesenseProductSearchConfig) {
    let base: URL;
    try { base = new URL(config.url); } catch { throw new TypeError('Typesense URL is invalid'); }
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash
      || !/^[A-Za-z0-9_-]{1,64}$/.test(config.collection) || typeof config.apiKey !== 'string' || config.apiKey.trim().length < 1) {
      throw new TypeError('Typesense search configuration is invalid');
    }
    this.baseUrl = new URL(base.toString().endsWith('/') ? base.toString() : `${base.toString()}/`);
    this.requestFetch = config.fetch ?? globalThis.fetch;
    this.timeoutMs = config.timeoutMs ?? 5_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 30_000) throw new TypeError('Typesense timeout must be 100-30000ms');
  }

  async upsert(document: ProductSearchDocument): Promise<void> {
    await this.request(`collections/${encodeURIComponent(this.config.collection)}/documents?action=upsert`, 'POST', JSON.stringify(document));
  }

  async tombstone(productId: string): Promise<void> {
    await this.request(`collections/${encodeURIComponent(this.config.collection)}/documents/${encodeURIComponent(productId)}?ignore_not_found=true`, 'DELETE');
  }

  private async request(path: string, method: 'POST' | 'DELETE', body?: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.requestFetch(new URL(path, this.baseUrl), {
        method, headers: { 'X-TYPESENSE-API-KEY': this.config.apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body } : {}), signal: controller.signal,
      });
      if (!response.ok) {
        const code = response.status === 408 || response.status === 429 || response.status >= 500 ? 'EAI_AGAIN' : 'TYPESENSE_REJECTED';
        throw Object.assign(new Error('Typesense rejected the projection request'), { code });
      }
      if (method === 'POST') {
        const result: unknown = await response.json();
        if (!result || typeof result !== 'object' || !('id' in result) || (result as { id?: unknown }).id !== JSON.parse(body ?? '{}').id) {
          throw Object.assign(new Error('Typesense returned an invalid upsert receipt'), { code: 'TYPESENSE_INVALID_RESPONSE' });
        }
      }
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'TYPESENSE_REJECTED' || code === 'TYPESENSE_INVALID_RESPONSE' || code === 'EAI_AGAIN') throw error;
      if (controller.signal.aborted) throw Object.assign(new Error('Typesense request timed out'), { code: 'ETIMEDOUT' });
      throw Object.assign(new Error('Typesense is unavailable'), { code: 'EAI_AGAIN' });
    } finally { clearTimeout(timeout); }
  }
}
