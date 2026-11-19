'use strict';

/** Synthetic demo cases ONLY for an isolated loopback PostgreSQL 16 database. */
// Usage: RENIVET_ALLOW_DISPOSABLE_SEED=1 RENIVET_TEST_DATABASE_URL=postgresql://renivet_ci:<password>@127.0.0.1:5432/renivet_ci node scripts/seed-ren2-117-disposable-reviews.cjs
(async function seed() {
  'use strict';
  const assert = require('node:assert/strict');
  const {randomUUID} = require('node:crypto');
  const {Pool} = require('pg');
  const {TaxonomyAdminPostgresRepository} = require('../dist/modules/catalog/taxonomy-admin.repository.js');
  const {CatalogReviewPostgresRepository} = require('../dist/modules/catalog/catalog-review.repository.js');
  const {snapshotSha256} = require('../dist/modules/catalog/catalog-submission.js');
  assert.equal(process.env.RENIVET_ALLOW_DISPOSABLE_SEED,'1','Explicit disposable database seed opt-in required');
  assert.notEqual(process.env.NODE_ENV,'production');
  const raw=process.env.RENIVET_TEST_DATABASE_URL;
  assert.ok(raw,'Set RENIVET_TEST_DATABASE_URL to disposable PostgreSQL');
  const u=new URL(raw);
  assert.equal(u.protocol,'postgresql:');
  assert.equal(u.hostname,'127.0.0.1');
  assert.equal(u.username,'renivet_ci');
  assert.equal(u.pathname,'/renivet_ci');
  assert.equal(u.port,'5432');
  const pool=new Pool({connectionString:raw,max:6,connectionTimeoutMillis:5000});
  const suffix=randomUUID().replaceAll('-','').slice(0,16);
  const label='ren2_117_demo';
  let client;
  try{
    const v=Number((await pool.query('SHOW server_version_num')).rows[0].server_version_num);
    assert.ok(v>=160000&&v<170000,'PostgreSQL 16 is required');
    client=await pool.connect();
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('ren2-117-disposable-demo',0))");
    const existing=await client.query("SELECT 1 FROM brands.brands WHERE slug=$1",['ren2-117-demo-approved']);
    if(existing.rowCount){await client.query('COMMIT');client.release();client=null;console.log('Synthetic cases already initialized; nothing changed.');return;}
    async function user(name){
      return (await client.query("INSERT INTO identity.users(email,display_name,state,email_verified_at) VALUES($1,$2,'active',CASE WHEN $3='reviewer' THEN now() ELSE NULL END) RETURNING id",[`${label}_${name}_${suffix}@example.invalid`,`REN2-117 DEMO ${name}`,name])).rows[0].id;
    }
    const maker=await user('maker'),reviewer=await user('reviewer'),applicant=await user('applicant'),grantor=await user('grantor');
    const pending=(await client.query("INSERT INTO brands.brands(slug,legal_name,display_name,onboarding_state) VALUES($1,$2,$3,'pending') RETURNING id",['ren2-117-demo-pending','REN2-117 demo application','REN2-117 Demo — Pending brand'])).rows[0].id;
    await client.query("INSERT INTO brands.brand_memberships(brand_id,user_id,membership_state,invited_by_id) VALUES($1,$2,'pending',$3)",[pending,applicant,grantor]);
    const brand=(await client.query("INSERT INTO brands.brands(slug,legal_name,display_name,onboarding_state) VALUES($1,$2,$3,'approved') RETURNING id",['ren2-117-demo-approved','REN2-117 Demo Products','REN2-117 Demo — Review brand'])).rows[0].id;
    const category=(await client.query("INSERT INTO catalogue.categories(code,name,active,schema_version) VALUES($1,$2,false,NULL) RETURNING id",[label+'_clothing','REN2-117 Demo Clothing'])).rows[0].id;
    await client.query("INSERT INTO catalogue.category_schema_versions(category_id,version,ruleset_sha256,validator_version) VALUES($1,1,repeat('a',64),'ren2-117-demo')",[category]);
    const rule=(await client.query("INSERT INTO catalogue.attributes(code,label,value_type,scope_type,allowed_values) VALUES($1,'Fabric','enum','product','[\"cotton\",\"linen\"]'::jsonb) RETURNING id,code",[label+'_fabric'])).rows[0];
    const taxonomyCategory=(await client.query("INSERT INTO catalogue.categories(code,name,active,schema_version) VALUES($1,$2,false,NULL) RETURNING id",[label+'_taxonomy','REN2-117 Demo Home Textiles'])).rows[0].id;
    const role=(await client.query("SELECT id FROM access.roles WHERE role_code='renivet_admin' AND scope_kind='global'")).rows[0]?.id;
    assert.ok(role,'Migrated renivet_admin role required');
    const perm=(await client.query("SELECT id FROM access.permissions WHERE permission_code='catalog.review'")).rows[0]?.id;
    assert.ok(perm,'Migrated catalog.review permission required');
    await client.query("INSERT INTO access.role_permissions(role_id,permission_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[role,perm]);
    await client.query("INSERT INTO access.role_assignments(user_id,role_id,brand_id,scope_type,active_from,granted_by_id) VALUES($1,$2,NULL,'global',now(),$3)",[reviewer,role,grantor]);
    async function product(title,priceState,publicationState){
      const pid=randomUUID(),vid=randomUUID(),priceId=randomUUID(),revisionId=randomUUID(),assetId=randomUUID(),mediaId=randomUUID();
      const row=(await client.query("INSERT INTO catalogue.products(id,brand_id,category_id,style_code,title,category_schema_version,publication_state,qc_state) VALUES($1,$2,$3,$4,$5,1,$6,'PENDING') RETURNING row_version",[pid,brand,category,`demo_${title}_${suffix}`,`REN2-117 Demo ${title}`,publicationState])).rows[0];
      await client.query("INSERT INTO catalogue.product_variants(id,brand_id,product_id,sku,option_signature,options,variant_state) VALUES($1,$2,$3,$4,$5,'{}'::jsonb,'ACTIVE')",[vid,brand,pid,`demo_${title}_${suffix}`,`demo_signature_${title}`]);
      await client.query("INSERT INTO catalogue.variant_prices(id,brand_id,variant_id,currency,amount_minor,mrp_minor,valid_from,valid_to,price_state,rule_version) VALUES($1,$2,$3,'INR',5000,7000,now()-interval '1 day',now()+interval '10 days',$4,1)",[priceId,brand,vid,priceState]);
      await client.query("INSERT INTO media.media_assets(id,brand_id,storage_key,sha256,mime_type,scan_state,rights_state,derivative_state,completed_at,rights_attested_by,rights_attested_at) VALUES($1,$2,$3,NULL,'image/webp','PENDING','ATTESTED','PENDING',NULL,$4,now())",[assetId,brand,`ren2-117/${title}/${suffix}`,maker]);
      for(const kind of ['PREVIEW','THUMBNAIL'])await client.query("INSERT INTO media.media_derivatives(brand_id,media_asset_id,derivative_kind,storage_key,sha256,mime_type,byte_length,width,height) VALUES($1,$2,$3,$4,repeat('c',64),'image/webp',16,400,400)",[brand,assetId,kind,`ren2-117/${title}/${kind}/${suffix}`]);
      await client.query("UPDATE media.media_assets SET sha256=repeat('b',64),scan_state='CLEAN',derivative_state='READY',completed_at=now(),row_version=row_version+1 WHERE id=$1",[assetId]);
      await client.query("INSERT INTO media.product_media(id,brand_id,product_id,media_asset_id,display_role,display_order,alt_text) VALUES($1,$2,$3,$4,'PRIMARY',0,'Demo listing photo')",[mediaId,brand,pid,assetId]);
      const snapshot={schema:'renivet.product-revision.v1',product:{id:pid,brandId:brand,contentVersion:1},variants:[{id:vid,approvedPrice:{id:priceId}}],media:[{id:mediaId,assetId}],claims:[]};
      await client.query("INSERT INTO catalogue.product_revisions(id,brand_id,product_id,content_version,content_snapshot,content_sha256,submitted_by,review_state,category_id,category_schema_version) VALUES($1,$2,$3,1,$4::jsonb,$5,$6,'SUBMITTED',$7,1)",[revisionId,brand,pid,JSON.stringify(snapshot),snapshotSha256(snapshot),maker,category]);
      return {pid,vid,priceId,revisionId,rowVersion:Number(row.row_version)};
    }
    await product('quality','APPROVED','PENDING_REVIEW');
    const publishing=await product('publishing','APPROVED','PENDING_REVIEW');
    await product('pricing','PENDING','DRAFT');
    const claim=await product('claim','APPROVED','DRAFT');
    await client.query("INSERT INTO catalogue.sustainability_claims(brand_id,product_id,revision_id,claim_code,claim_text,claim_state,submitted_by) VALUES($1,$2,$3,'RECYCLED_CONTENT','Synthetic review claim','PENDING',$4)",[brand,claim.pid,claim.revisionId,maker]);
    await client.query('COMMIT');client.release();client=null;
    const taxonomy=new TaxonomyAdminPostgresRepository({pool});
    await taxonomy.propose({categoryId:taxonomyCategory,version:1,validatorVersion:'w2-attribute-validator-v1',ruleset:{attributes:[{attributeId:rule.id,code:rule.code,scope:'product',valueType:'enum',allowedValues:['cotton','linen'],requiredByDefault:true}]}},{actorId:maker,requestId:'ren2-117-demo-taxonomy',idempotencyKey:'ren2-117-demo-propose'});
    const reviews=new CatalogReviewPostgresRepository({pool});
    await reviews.decide(publishing.pid,{decision:'APPROVED',reasonCode:'QC_PASSED',expectedRevisionId:publishing.revisionId,expectedRowVersion:publishing.rowVersion,comment:'Synthetic review approval'},{userId:reviewer,brandId:brand,idempotencyKey:'ren2-117-demo-publishing'});
    console.log('Synthetic local queues seeded: brand application, taxonomy, QC, pricing, claims, publishing.');
    console.log('Demo approved brand:',brand,'Demo pending brand:',pending);
    console.log('No real users, financial records, email messages or stock commitments were created.');
  }catch(e){
    if(client){await client.query('ROLLBACK').catch(()=>{});client.release();}
    throw e;
  }finally{await pool.end();}
})().catch(e=>{console.error('Disposable seed failed:',e?.code||e?.message||'unknown');process.exitCode=1;});
