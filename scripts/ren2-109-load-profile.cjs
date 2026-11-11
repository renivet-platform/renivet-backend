'use strict';

const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { Pool } = require('pg');
const JSZip = require('jszip');
const sharp = require('sharp');
const { DurableWorker } = require('../dist/workers/durable-worker.js');
const { parseCatalogCsv } = require('../dist/modules/imports/import-csv-parser.js');
const { ImportPreviewService } = require('../dist/modules/imports/import-preview.service.js');
const { TaxonomyAdminPostgresRepository } = require('../dist/modules/catalog/taxonomy-admin.repository.js');
const { ingestImageZip, MAX_MEDIA_ZIP_BYTES, MAX_MEDIA_ZIP_EXPANDED_BYTES } = require('../dist/modules/media/media-zip-ingestion.js');
const { SharpMediaImageProcessor } = require('../dist/modules/media/sharp-media-image-processor.js');

const APPROVED_CPU_CORES = 4;
const APPROVED_MEMORY_BYTES = 8 * 1024 * 1024 * 1024;

function assertDisposableUrl(raw) {
  assert.equal(process.env.RENIVET_LOAD_PROFILE, '1', 'set RENIVET_LOAD_PROFILE=1 to opt in to this synthetic profile');
  assert.ok(raw, 'RENIVET_TEST_DATABASE_URL is required');
  const url = new URL(raw);
  assert.equal(url.protocol, 'postgresql:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/renivet_ci');
  assert.equal(url.username, 'renivet_ci');
  return url;
}

function elapsed(start) { return Number(process.hrtime.bigint() - start) / 1e6; }

function readCgroupNumber(path) {
  try {
    const value = readFileSync(path, 'utf8').trim();
    return value === 'max' ? null : Number(value);
  } catch { return null; }
}

function readCgroupCpuLimit() {
  let quotaCores = null;
  try {
    const [quota, period] = readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/).map(Number);
    quotaCores = quota > 0 && period > 0 ? quota / period : null;
  } catch {
    try {
      const quota = Number(readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_quota_us', 'utf8').trim());
      const period = Number(readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_period_us', 'utf8').trim());
      quotaCores = quota > 0 && period > 0 ? quota / period : null;
    } catch { quotaCores = null; }
  }
  let cpuSetCores = null;
  try {
    const cpuSet = readFileSync('/sys/fs/cgroup/cpuset.cpus.effective', 'utf8').trim();
    cpuSetCores = cpuSet.split(',').reduce((total, range) => {
      const [start, end = start] = range.split('-').map(Number);
      return total + end - start + 1;
    }, 0);
  } catch {
    try {
      const cpuSet = readFileSync('/sys/fs/cgroup/cpuset/cpuset.cpus', 'utf8').trim();
      cpuSetCores = cpuSet.split(',').reduce((total, range) => {
        const [start, end = start] = range.split('-').map(Number);
        return total + end - start + 1;
      }, 0);
    } catch { cpuSetCores = null; }
  }
  return quotaCores === null ? cpuSetCores : cpuSetCores === null ? quotaCores : Math.min(quotaCores, cpuSetCores);
}

function readCgroupCpuUsageMicros() {
  try {
    const usage = readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8').match(/^usage_usec\s+(\d+)$/m);
    return usage ? Number(usage[1]) : null;
  } catch { return null; }
}

function readContainerBudget() {
  let memoryLimitBytes = readCgroupNumber('/sys/fs/cgroup/memory.max');
  let memoryPeakBytes = readCgroupNumber('/sys/fs/cgroup/memory.peak');
  let cpuUsageMicros = readCgroupCpuUsageMicros();
  if (memoryLimitBytes === null) {
    const v1Limit = readCgroupNumber('/sys/fs/cgroup/memory/memory.limit_in_bytes');
    memoryLimitBytes = v1Limit !== null && v1Limit < 1_000_000_000_000_000 ? v1Limit : null;
  }
  if (memoryPeakBytes === null) memoryPeakBytes = readCgroupNumber('/sys/fs/cgroup/memory/memory.max_usage_in_bytes');
  if (cpuUsageMicros === null) {
    const nanoseconds = readCgroupNumber('/sys/fs/cgroup/cpuacct/cpuacct.usage');
    cpuUsageMicros = nanoseconds === null ? null : Math.round(nanoseconds / 1000);
  }
  return {
    cpuCores: readCgroupCpuLimit(),
    memoryLimitBytes,
    memoryPeakBytes,
    cpuUsageMicros,
  };
}

async function makeSyntheticJpeg(seed) {
  const width = 192;
  const height = 192;
  const pixels = Buffer.allocUnsafe(width * height * 3);
  let state = seed >>> 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      state = (state * 1664525 + 1013904223) >>> 0;
      const noise = ((state >>> 24) - 128) / 12;
      const offset = (y * width + x) * 3;
      pixels[offset] = Math.max(0, Math.min(255, 60 + ((x * 3 + y) % 120) + noise));
      pixels[offset + 1] = Math.max(0, Math.min(255, 80 + ((y * 2 + x) % 90) + noise));
      pixels[offset + 2] = Math.max(0, Math.min(255, 100 + ((x + y * 2) % 100) + noise));
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 62 }).toBuffer();
}

async function main() {
  const sourceUrl = assertDisposableUrl(process.env.RENIVET_TEST_DATABASE_URL);
  const adminUrl = new URL(sourceUrl);
  adminUrl.pathname = '/postgres';
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1, connectionTimeoutMillis: 5_000 });
  const databaseName = `ren2_109_${randomUUID().replaceAll('-', '')}`;
  let createdDatabase = false;
  let pool;
  const cpuStart = process.cpuUsage();
  const rssStart = process.memoryUsage().rss;
  const cgroupStart = readContainerBudget();
  let peakRss = rssStart;
  let peakWaiting = 0;
  let rssSampler;
  const report = { profile: 'REN2-109 disposable synthetic profile', limits: 'Owner-approved qualification cap: 4 CPU cores and 8 GiB; not a production capacity limit.' };
  try {
    if (process.env.RENIVET_LOAD_PROFILE_REQUIRE_LIMITS === '1') {
      assert.ok(cgroupStart.cpuCores > 0 && cgroupStart.cpuCores <= APPROVED_CPU_CORES,
        'the effective profile CPU limit must be present and no greater than 4 cores');
      assert.ok(cgroupStart.memoryLimitBytes > 0 && cgroupStart.memoryLimitBytes <= APPROVED_MEMORY_BYTES,
        'the effective profile memory limit must be present and no greater than 8 GiB');
    }
    const role = await admin.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user');
    assert.equal(role.rows[0]?.rolsuper, true, 'the disposable test role must be superuser to create/drop the isolated profile copy');
    await admin.query(`CREATE DATABASE "${databaseName}" TEMPLATE renivet_ci`);
    createdDatabase = true;
    const profileUrl = new URL(sourceUrl);
    profileUrl.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: profileUrl.toString(), max: 8, connectionTimeoutMillis: 30_000 });
    rssSampler = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      peakWaiting = Math.max(peakWaiting, pool?.waitingCount ?? 0);
    }, 10);

    const version = await pool.query('SHOW server_version_num');
    assert.ok(Number(version.rows[0].server_version_num) >= 160000 && Number(version.rows[0].server_version_num) < 170000,
      'the profile requires PostgreSQL 16');

    const suffix = randomUUID().replaceAll('-', '');
    const actor = (await pool.query(`INSERT INTO identity.users(email,display_name,state)
      VALUES($1,'REN2-109 synthetic owner','active') RETURNING id`, [`ren2-109-${suffix}@example.invalid`])).rows[0].id;
    const grantor = (await pool.query(`INSERT INTO identity.users(email,display_name,state)
      VALUES($1,'REN2-109 synthetic grantor','active') RETURNING id`, [`ren2-109-grantor-${suffix}@example.invalid`])).rows[0].id;
    const brand = (await pool.query(`INSERT INTO brands.brands(slug,legal_name,display_name,onboarding_state)
      VALUES($1,'REN2-109 synthetic','REN2-109 synthetic','approved') RETURNING id`, [`ren2-109-${suffix}`])).rows[0].id;
    await pool.query(`INSERT INTO brands.brand_memberships(brand_id,user_id,membership_state,invited_by_id,joined_at)
      VALUES($1,$2,'active',$3,now())`, [brand, actor, grantor]);
    const roleId = (await pool.query(`INSERT INTO access.roles(role_code,scope_kind,description,is_system)
      VALUES($1,'brand','REN2-109 disposable import profile',false) RETURNING id`, [`r109_${suffix}`])).rows[0].id;
    for (const permissionCode of ['imports.read', 'imports.write']) {
      const action = permissionCode.slice(permissionCode.indexOf('.') + 1);
      const permissionId = (await pool.query(`INSERT INTO access.permissions(permission_code,resource,action,description)
        VALUES($1,'imports',$2,'REN2-109 disposable import profile')
        ON CONFLICT(permission_code) DO UPDATE SET permission_code=EXCLUDED.permission_code RETURNING id`, [permissionCode, action])).rows[0].id;
      await pool.query('INSERT INTO access.role_permissions(role_id,permission_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [roleId, permissionId]);
    }
    await pool.query(`INSERT INTO access.role_assignments(user_id,role_id,brand_id,scope_type,active_from,granted_by_id)
      VALUES($1,$2,$3,'brand',now(),$4)`, [actor, roleId, brand, grantor]);
    const categoryCode = `R109_${suffix.slice(0, 20)}`;
    const categoryId = (await pool.query('INSERT INTO catalogue.categories(code,name,active) VALUES($1,$2,false) RETURNING id',
      [categoryCode, 'REN2-109 synthetic category'])).rows[0].id;
    const attributeCode = `r109_material_${suffix.slice(0, 12)}`;
    const attribute = (await pool.query(`INSERT INTO catalogue.attributes(code,label,value_type,scope_type)
      VALUES($1,'Synthetic profile material','text','product') RETURNING id,code`, [attributeCode])).rows[0];
    const taxonomy = new TaxonomyAdminPostgresRepository({ pool });
    const taxonomyRequest = `r109:${suffix}`;
    try {
      await taxonomy.propose({ categoryId, version: 1, validatorVersion: 'w2-attribute-validator-v1', ruleset: { attributes: [
        { attributeId: attribute.id, code: attribute.code, scope: 'product', valueType: 'text', requiredByDefault: false },
      ] } },
        { actorId: actor, requestId: taxonomyRequest, idempotencyKey: `r109-profile-taxonomy-propose-${suffix}` });
    } catch (error) { throw new Error(`taxonomy proposal failed: ${error?.response?.code ?? error?.code ?? error?.status ?? 'unknown'}`); }
    try {
      await taxonomy.publish({ categoryId, version: 1 }, { actorId: grantor, requestId: taxonomyRequest,
        idempotencyKey: `r109-profile-taxonomy-publish-${suffix}` });
    } catch (error) { throw new Error(`taxonomy publication failed: ${error?.response?.code ?? error?.code ?? error?.status ?? 'unknown'}`); }
    const activation = await pool.connect();
    try {
      await activation.query('BEGIN');
      await activation.query(`SELECT set_config('app.taxonomy_actor_user_id',$1,true),set_config('app.taxonomy_request_id',$2,true),
        set_config('app.taxonomy_reason_code','INITIAL_ACTIVATION',true)`, [grantor, taxonomyRequest]);
      await activation.query('UPDATE catalogue.categories SET active=true WHERE id=$1', [categoryId]);
      await activation.query('COMMIT');
    } catch (error) { await activation.query('ROLLBACK'); throw error; } finally { activation.release(); }

    const parseSamples = [];
    const dbWriteSamples = [];
    const previewSamples = [];
    let totalRows = 0;
    let totalInvalid = 0;
    let totalBytes = 0;
    const previewService = new ImportPreviewService({ pool });
    let firstBatchId;
    let firstPreviewHash;
    for (let fileIndex = 0; fileIndex < 4; fileIndex += 1) {
      const lines = ['sku,style,title,category'];
      for (let rowIndex = 0; rowIndex < 5_000; rowIndex += 1) {
        const sequence = fileIndex * 5_000 + rowIndex + 1;
        const sku = `R109-${suffix.slice(0, 8)}-${String(sequence).padStart(5, '0')}`;
        const title = rowIndex % 100 === 0 ? '' : `Synthetic profile product ${sequence}`;
        lines.push(`${sku},STYLE-${sequence},${title},Tops`);
      }
      const bytes = Buffer.from(lines.join('\n'), 'utf8');
      totalBytes += bytes.length;
      const parseStart = process.hrtime.bigint();
      const parsed = parseCatalogCsv({ bytes, sourceKind: 'GENERIC_CSV' });
      parseSamples.push(elapsed(parseStart));
      assert.equal(parsed.rawRows.length, 5_000);
      assert.equal(parsed.rowErrors.length, 50);
      const parsedCanonical = new Map(parsed.catalogRowNumbers.map((rowNumber, index) => [rowNumber, parsed.catalogRows[index]]));
      const sourceHash = createHash('sha256').update(bytes).digest('hex');
      const batch = (await pool.query(`INSERT INTO imports.import_batches
        (brand_id,source_kind,source_sha256,raw_storage_key,schema_version,source_as_of,job_state,requested_policy,created_by)
        VALUES($1,'GENERIC_CSV',$2,$3,'ren2-109-profile-v1',now(),'RECEIVED','{"mode":"CREATE_ONLY"}'::jsonb,$4) RETURNING id`,
      [brand, sourceHash, `ren2-109/${suffix}/file-${fileIndex + 1}.csv`, actor])).rows[0].id;
      if (fileIndex === 0) firstBatchId = batch;
      const rows = parsed.rawRows;
      const errorsByRow = new Map(parsed.rowErrors.map((item) => [item.sourceRowNumber, [{ code: item.code }]]));
      const params = [];
      const placeholders = [];
      for (const row of rows) {
        const canonical = parsedCanonical.get(row.sourceRowNumber) ?? {};
        const offset = params.length;
        params.push(batch, brand, row.sourceRowNumber, JSON.stringify(row.rawRecord), JSON.stringify(canonical), JSON.stringify(errorsByRow.get(row.sourceRowNumber) ?? []));
        placeholders.push(`($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4}::jsonb,$${offset + 5}::jsonb,$${offset + 6}::jsonb)`);
      }
      const insertStart = process.hrtime.bigint();
      await pool.query(`INSERT INTO imports.import_rows(batch_id,brand_id,source_row_number,raw_record,canonical_record,validation_errors) VALUES ${placeholders.join(',')}`, params);
      dbWriteSamples.push(elapsed(insertStart));
      totalRows += rows.length;
      totalInvalid += parsed.rowErrors.length;

      const request = { brandId: brand, batchId: batch, actorUserId: actor, idempotencyKey: `r109-profile-map-${suffix}-${fileIndex}`,
        expectedVersion: 0, requestId: `r109-profile:${suffix}:${fileIndex}`,
        mapping: { fieldMappings: { sku: 'sku', style: 'styleCode', title: 'title', category: 'categoryCode' }, categoryMappings: { Tops: categoryCode } } };
      const previewStart = process.hrtime.bigint();
      if (fileIndex === 0) {
        // Hold one connection on a synthetic slow query while eight identical writes contend on a bounded pool.
        const held = await pool.connect();
        try {
          const slowQuery = held.query('SELECT pg_sleep(0.25)');
          const retryStorm = await Promise.all(Array.from({ length: 8 }, () => previewService.saveMapping(request)));
          await slowQuery;
          assert.ok(retryStorm.every((item) => item.previewHash === retryStorm[0].previewHash), 'concurrent retries share one saved preview');
          firstPreviewHash = retryStorm[0].previewHash;
        } finally { held.release(); }
      } else {
        await previewService.saveMapping(request);
      }
      previewSamples.push(elapsed(previewStart));
      const storedPreview = await previewService.getPreview({ brandId: brand, batchId: batch, userId: actor, requestId: `r109-read:${suffix}:${fileIndex}` });
      assert.equal(storedPreview.rows.length, 5_000);
      assert.equal(storedPreview.rows.filter((row) => row.action === 'INVALID').length, 50);
      if (fileIndex === 0) {
        await assert.rejects(previewService.getPreview({ brandId: randomUUID(), batchId: batch, userId: actor, requestId: `r109-foreign:${suffix}` }),
          (error) => error?.status === 404);
      }
    }
    assert.equal(totalRows, 20_000);
    assert.equal(totalInvalid, 200);

    // Recreate the pool as a process restart boundary and prove the saved preview remains readable.
    await pool.end();
    pool = new Pool({ connectionString: profileUrl.toString(), max: 8, connectionTimeoutMillis: 30_000 });
    const resumed = await new ImportPreviewService({ pool }).getPreview({ brandId: brand, batchId: firstBatchId, userId: actor, requestId: `r109-resume:${suffix}` });
    assert.equal(resumed.previewHash, firstPreviewHash);

    const imageCount = 12_000;
    const imageZip = new JSZip();
    const imageSamples = await Promise.all(Array.from({ length: 12 }, (_, index) => makeSyntheticJpeg(index + 1)));
    const imageBytes = imageSamples[0];
    const skuManifest = Object.create(null);
    for (let index = 0; index < imageCount; index += 1) {
      const sku = `IMG${String(index + 1).padStart(5, '0')}`;
      const hex = (index + 1).toString(16).padStart(12, '0');
      skuManifest[sku] = { productId: `00000000-0000-4000-8000-${hex}`, variantId: `00000000-0000-4001-8000-${hex}` };
      imageZip.file(`${sku}__01.jpg`, imageSamples[index % imageSamples.length]);
    }
    const zipStart = process.hrtime.bigint();
    const zipBytes = await imageZip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
    const expandedImageBytes = imageSamples.reduce((total, sample) => total + sample.length, 0) * (imageCount / imageSamples.length);
    assert.ok(zipBytes.length <= MAX_MEDIA_ZIP_BYTES, 'synthetic image archive must remain within the product ZIP limit');
    assert.ok(expandedImageBytes <= MAX_MEDIA_ZIP_EXPANDED_BYTES, 'synthetic image payload must remain within the expanded ZIP limit');
    let active = 0;
    let peakActive = 0;
    let imageDerivativeBytes = 0;
    let imageDerivatives = 0;
    const processor = new SharpMediaImageProcessor();
    const imageResult = await ingestImageZip({ bytes: zipBytes, brandId: randomUUID(), batchId: randomUUID(), manifest: skuManifest, concurrency: 3,
      resolveProducts: async (scope, mappings) => Object.fromEntries(Object.entries(mappings).map(([sku, mapping]) => [sku,
        { brandId: scope, productId: mapping.productId, variantId: mapping.variantId, sku }])),
      processImage: async (image) => {
        active += 1;
        peakActive = Math.max(peakActive, active);
        try {
          const derivatives = await processor.createDerivatives(image.bytes, image.mimeType, image.brandId, randomUUID());
          assert.equal(derivatives.length, 2);
          assert.ok(derivatives.every((item) => item.mimeType === 'image/webp' && item.bytes.length > 0));
          imageDerivativeBytes += derivatives.reduce((total, item) => total + item.bytes.length, 0);
          imageDerivatives += derivatives.length;
        } finally { active -= 1; }
      } });
    const imageElapsedMs = elapsed(zipStart);
    assert.equal(imageResult.processed, imageCount);
    assert.equal(imageDerivatives, imageCount * 2);
    assert.ok(peakActive <= 3);

    const workerEvents = 100;
    const workerConsumerId = `r109_profile_${suffix.slice(0, 16)}`;
    const workerEventType = 'ren2_109.profile_event';
    const eventValues = [];
    const eventPlaceholders = [];
    for (let index = 0; index < workerEvents; index += 1) {
      const offset = eventValues.length;
      eventValues.push(randomUUID(), workerEventType, 1, JSON.stringify({ profileIndex: index }), `r109:${suffix}:${index}`);
      eventPlaceholders.push(`('ren2_109_profile',$${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4}::jsonb,$${offset + 5})`);
    }
    const workerEventSql = `INSERT INTO platform.outbox_events(aggregate_type,aggregate_id,event_type,event_version,event_payload,event_key)
      VALUES ${eventPlaceholders.join(',')}`;
    const workerOutboxStart = process.hrtime.bigint();
    await pool.query(workerEventSql, eventValues);
    const workerOutboxMs = elapsed(workerOutboxStart);
    let activeWorkerEffects = 0;
    let peakWorkerEffects = 0;
    const worker = new DurableWorker(pool, [{ consumerId: workerConsumerId, eventTypes: [workerEventType], authorization: { scope: 'system' },
      async handle(event, transaction) {
        activeWorkerEffects += 1;
        peakWorkerEffects = Math.max(peakWorkerEffects, activeWorkerEffects);
        await transaction.query('INSERT INTO system_events(event_name) VALUES($1)', [`r109:${suffix}:${event.id}`]);
        await new Promise((resolve) => setImmediate(resolve));
        activeWorkerEffects -= 1;
      } }], { leaseSeconds: 60, maxAttempts: 3, baseRetryDelayMs: 1, maxRetryDelayMs: 10, jitterMs: 0, random: () => 0 });
    const enqueueStart = process.hrtime.bigint();
    const enqueued = await worker.enqueueOutboxBatch(workerEvents);
    const enqueueMs = elapsed(enqueueStart);
    assert.equal(enqueued, workerEvents);
    const claimStart = process.hrtime.bigint();
    const claims = await Promise.all(Array.from({ length: 8 }, (_, index) => worker.claim(workerConsumerId, `r109:${suffix}:claim-${index}`, 25)));
    const claimMs = elapsed(claimStart);
    const claimedJobs = claims.flat();
    assert.equal(claimedJobs.length, workerEvents);
    assert.equal(new Set(claimedJobs.map((job) => job.id)).size, workerEvents, 'competing claimers receive disjoint leases');
    let nextJob = 0;
    const workerProcessStart = process.hrtime.bigint();
    const results = await Promise.all(Array.from({ length: 8 }, async () => {
      while (nextJob < claimedJobs.length) {
        const index = nextJob++;
        assert.equal(await worker.process(claimedJobs[index]), 'processed');
      }
    }));
    void results;
    const workerProcessMs = elapsed(workerProcessStart);
    const workerState = await pool.query(`SELECT state,count(*)::integer AS count FROM platform.durable_jobs WHERE job_kind=$1 GROUP BY state`, [workerConsumerId]);
    const succeededJobs = Number(workerState.rows.find((row) => row.state === 'succeeded')?.count ?? 0);
    assert.equal(succeededJobs, workerEvents);

    clearInterval(rssSampler);
    rssSampler = undefined;
    const cgroupEnd = readContainerBudget();
    const maxRssMultiplier = process.platform === 'win32' ? 1 : 1024;
    peakRss = Math.max(peakRss, process.memoryUsage().rss, process.resourceUsage().maxRSS * maxRssMultiplier);
    const cpu = process.cpuUsage(cpuStart);
    report.serverVersion = version.rows[0].server_version_num;
    report.catalogFiles = 4;
    report.catalogRows = totalRows;
    report.invalidRowsIsolated = totalInvalid;
    report.sourceBytes = totalBytes;
    report.parser = { totalMs: Math.round(parseSamples.reduce((a, b) => a + b, 0)), perFileMs: parseSamples.map(Math.round), rowsPerSecond: Math.round(totalRows / (parseSamples.reduce((a, b) => a + b, 0) / 1000)) };
    report.postgres = { rowInsertMs: dbWriteSamples.map(Math.round), previewTransactionMs: previewSamples.map(Math.round), resumedPreviewHashMatches: true,
      concurrentExactRetries: 8, syntheticPoolBackpressurePeakWaiting: peakWaiting, foreignBrandPreviewDenied: true };
    report.images = { count: imageResult.processed, dimensions: '192x192 pixels', distinctSyntheticSamples: imageSamples.length,
      uncompressedImageBytes: expandedImageBytes, meanImageBytes: Math.round(expandedImageBytes / imageCount), zipBytes: zipBytes.length,
      elapsedMs: Math.round(imageElapsedMs), imagesPerSecond: Math.round(imageCount / (imageElapsedMs / 1000)), configuredConcurrency: 3, observedPeakConcurrency: peakActive,
      processor: 'real Sharp JPEG decode and WebP preview/thumbnail transformations; synthetic images, no ClamAV, object storage or DB effect persistence',
      derivativesCreated: imageDerivatives, derivativeBytes: imageDerivativeBytes };
    report.worker = { outboxEvents: workerEvents, outboxInsertMs: Math.round(workerOutboxMs), enqueued, enqueueMs: Math.round(enqueueMs),
      competingClaimers: 8, claimBatchLimit: 25, disjointLeasesClaimed: claimedJobs.length, claimMs: Math.round(claimMs),
      processParallelism: 8, observedPeakEffects: peakWorkerEffects, processMs: Math.round(workerProcessMs), succeededJobs };
    report.process = { startRssBytes: rssStart, peakRssBytes: peakRss, peakRssMiB: Number((peakRss / (1024 * 1024)).toFixed(1)), cpuUserMs: Math.round(cpu.user / 1000), cpuSystemMs: Math.round(cpu.system / 1000) };
    report.resourceBudget = {
      approvedTestLimit: { cpuCores: APPROVED_CPU_CORES, memoryBytes: APPROVED_MEMORY_BYTES },
      observedCgroupLimit: { cpuCores: cgroupEnd.cpuCores, memoryBytes: cgroupEnd.memoryLimitBytes, memoryPeakBytes: cgroupEnd.memoryPeakBytes,
        cpuUsageMicros: cgroupStart.cpuUsageMicros === null || cgroupEnd.cpuUsageMicros === null ? null : cgroupEnd.cpuUsageMicros - cgroupStart.cpuUsageMicros },
      includes: 'Node load profile and disposable PostgreSQL server ran in the same capped container',
    };
    report.databaseProfile = 'imports and previews ran against an isolated clone of the disposable PostgreSQL test database; clone dropped after this run';
    console.log(JSON.stringify(report, null, 2));
  } finally {
    clearInterval(rssSampler);
    let cleanupError;
    try { await pool?.end(); } catch (error) { cleanupError = error; }
    try {
      if (createdDatabase) {
        await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
        createdDatabase = false;
        const remaining = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [databaseName]);
        assert.equal(remaining.rowCount, 0, 'the disposable profile database must be removed after the run');
      }
    } catch (error) { cleanupError ??= error; }
    try { await admin.end(); } catch (error) { cleanupError ??= error; }
    if (cleanupError) throw cleanupError;
  }
}

main().catch((error) => {
  console.error('REN2-109 profile failed:', error?.message ?? 'unknown error');
  process.exitCode = 1;
});
