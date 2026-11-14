-- REN2-54 loads the owner-approved Pilot v1 catalog data as inactive categories and attribute definitions.
-- Leaf schemas remain unpublished and inactive until proposed and independently published through W1 taxonomy controls.
CREATE TABLE catalogue.taxonomy_seed_datasets(dataset_id text NOT NULL,version integer NOT NULL CHECK(version>0),owner text NOT NULL,source_sha256 char(64) NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'),approval_reference text NOT NULL,imported_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(dataset_id,version));
--> statement-breakpoint
CREATE FUNCTION catalogue.reject_taxonomy_seed_dataset_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,catalogue AS $$ BEGIN RAISE EXCEPTION 'TAXONOMY_SEED_PROVENANCE_IMMUTABLE' USING ERRCODE='23514'; END; $$;
--> statement-breakpoint
CREATE TRIGGER taxonomy_seed_datasets_immutable BEFORE UPDATE OR DELETE ON catalogue.taxonomy_seed_datasets FOR EACH ROW EXECUTE FUNCTION catalogue.reject_taxonomy_seed_dataset_mutation();
--> statement-breakpoint
INSERT INTO catalogue.taxonomy_seed_datasets(dataset_id,version,owner,source_sha256,approval_reference) VALUES('renivet.catalog-taxonomy.apparel-pilot-v1',1,'Catalog Operations','5564d2f9a30964c1c8b826a2dfc86b3e19e9e2d2deb77dd5f3d9f95a5d16df17','Owner-approved Pilot v1 dataset; no new legal/compliance rules beyond current W2 policy.') ON CONFLICT(dataset_id,version) DO NOTHING;
--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM catalogue.taxonomy_seed_datasets WHERE dataset_id='renivet.catalog-taxonomy.apparel-pilot-v1' AND version=1 AND source_sha256='5564d2f9a30964c1c8b826a2dfc86b3e19e9e2d2deb77dd5f3d9f95a5d16df17') THEN RAISE EXCEPTION 'REN2-54 taxonomy dataset provenance hash conflicts with the installed Pilot v1'; END IF; END; $$;
--> statement-breakpoint
INSERT INTO catalogue.categories(id,parent_id,code,name,active,schema_version) VALUES ('346b5c43-6e27-5b9e-8c99-c3053eeb0019'::uuid,NULL::uuid,'apparel','Apparel',false,NULL) ON CONFLICT(code) DO NOTHING;
--> statement-breakpoint
INSERT INTO catalogue.categories(id,parent_id,code,name,active,schema_version) VALUES ('c59bf848-8328-52d2-b675-1d5bbca13104'::uuid,'346b5c43-6e27-5b9e-8c99-c3053eeb0019'::uuid,'t_shirts_tops','T-shirts and tops',false,NULL),
  ('b837f89d-d15b-5473-925c-3b5d4fc96964'::uuid,'346b5c43-6e27-5b9e-8c99-c3053eeb0019'::uuid,'shirts_blouses','Shirts and blouses',false,NULL),
  ('1af066e0-e191-5830-832d-a2274ac04a47'::uuid,'346b5c43-6e27-5b9e-8c99-c3053eeb0019'::uuid,'kurtas_tunics','Kurtas and tunics',false,NULL),
  ('67d76a81-dae4-523b-bd73-21fd85b7b631'::uuid,'346b5c43-6e27-5b9e-8c99-c3053eeb0019'::uuid,'dresses_jumpsuits','Dresses and jumpsuits',false,NULL),
  ('a828481e-ee8d-5770-9260-9a8361655538'::uuid,'346b5c43-6e27-5b9e-8c99-c3053eeb0019'::uuid,'trousers_jeans','Trousers and jeans',false,NULL),
  ('1b931a5f-b28c-5d2e-9bd0-d3b143b573e2'::uuid,'346b5c43-6e27-5b9e-8c99-c3053eeb0019'::uuid,'skirts_shorts','Skirts and shorts',false,NULL),
  ('c0f351c7-f298-508d-a565-ee28c8c63a02'::uuid,'346b5c43-6e27-5b9e-8c99-c3053eeb0019'::uuid,'jackets_outerwear','Jackets and outerwear',false,NULL),
  ('e040d097-c268-5d2f-aee4-9761f8ba31c6'::uuid,'346b5c43-6e27-5b9e-8c99-c3053eeb0019'::uuid,'activewear','Activewear',false,NULL) ON CONFLICT(code) DO NOTHING;
--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM (VALUES ('346b5c43-6e27-5b9e-8c99-c3053eeb0019'::uuid,NULL::uuid,'apparel','Apparel',false)) AS e(id,parent_id,code,name,active) LEFT JOIN catalogue.categories c ON c.code=e.code WHERE c.id IS DISTINCT FROM e.id OR c.parent_id IS DISTINCT FROM e.parent_id OR c.name IS DISTINCT FROM e.name OR c.active IS DISTINCT FROM false OR c.schema_version IS NOT NULL) THEN RAISE EXCEPTION 'REN2-54 category seed conflicts with existing taxonomy'; END IF;
 IF EXISTS(SELECT 1 FROM (VALUES ('c59bf848-8328-52d2-b675-1d5bbca13104'::uuid,'346b5c43-6e27-5b9e-8c99-c3053eeb0019'::uuid,'t_shirts_tops','T-shirts and tops',false),
  ('b837f89d-d15b-5473-925c-3b5d4fc96964'::uuid,'346b5c43-6e27-5b9e-8c99-c3053eeb0019'::uuid,'shirts_blouses','Shirts and blouses',false),
  ('1af066e0-e191-5830-832d-a2274ac04a47'::uuid,'346b5c43-6e27-5b9e-8c99-c3053eeb0019'::uuid,'kurtas_tunics','Kurtas and tunics',false),
  ('67d76a81-dae4-523b-bd73-21fd85b7b631'::uuid,'346b5c43-6e27-5b9e-8c99-c3053eeb0019'::uuid,'dresses_jumpsuits','Dresses and jumpsuits',false),
  ('a828481e-ee8d-5770-9260-9a8361655538'::uuid,'346b5c43-6e27-5b9e-8c99-c3053eeb0019'::uuid,'trousers_jeans','Trousers and jeans',false),
  ('1b931a5f-b28c-5d2e-9bd0-d3b143b573e2'::uuid,'346b5c43-6e27-5b9e-8c99-c3053eeb0019'::uuid,'skirts_shorts','Skirts and shorts',false),
  ('c0f351c7-f298-508d-a565-ee28c8c63a02'::uuid,'346b5c43-6e27-5b9e-8c99-c3053eeb0019'::uuid,'jackets_outerwear','Jackets and outerwear',false),
  ('e040d097-c268-5d2f-aee4-9761f8ba31c6'::uuid,'346b5c43-6e27-5b9e-8c99-c3053eeb0019'::uuid,'activewear','Activewear',false)) AS e(id,parent_id,code,name,active) LEFT JOIN catalogue.categories c ON c.code=e.code WHERE c.id IS DISTINCT FROM e.id OR c.parent_id IS DISTINCT FROM e.parent_id OR c.name IS DISTINCT FROM e.name OR c.active IS DISTINCT FROM false OR c.schema_version IS NOT NULL) THEN RAISE EXCEPTION 'REN2-54 category seed conflicts with existing taxonomy'; END IF;
END; $$;
--> statement-breakpoint
INSERT INTO catalogue.attributes(id,code,label,value_type,scope_type,allowed_values,unit_code,searchable,schema_version) VALUES ('78a928a0-867d-59ba-b437-6638b7ba9b0a'::uuid,'size','Size','enum','variant','["XS","S","M","L","XL","XXL","0","2","4","6","8","10","12","14","16","18","20","24","26","28","30","32","34","36","38","40","42","44"]'::jsonb,NULL,false,1),
  ('afee88de-d8aa-58d2-bbad-21c41e7710ef'::uuid,'color','Color','enum','variant','["black","white","ivory","grey","navy","blue","green","olive","red","pink","purple","yellow","orange","brown","beige","multicolor"]'::jsonb,NULL,false,1),
  ('8253576f-93a4-593a-bb7c-3f445ad56b01'::uuid,'material_composition','Material Composition','text','product','["cotton","linen","hemp","silk","wool","cashmere","viscose","modal","lyocell","polyester","nylon","acrylic","elastane","recycled_polyester","recycled_cotton"]'::jsonb,NULL,false,1),
  ('c71795de-4377-57b8-b731-c50c2a5a7b1b'::uuid,'fit','Fit','enum','product','["regular","slim","relaxed","oversized","fitted","compression"]'::jsonb,NULL,false,1),
  ('c1b66fe5-6d72-5243-ae5a-17a58c9300a3'::uuid,'care_instructions','Care Instructions','multi_enum','product','["machine_wash_cold","machine_wash_warm","hand_wash","do_not_wash","do_not_bleach","tumble_dry_low","line_dry","dry_flat","iron_low","iron_medium","do_not_iron","dry_clean"]'::jsonb,NULL,false,1),
  ('e2dd3fcc-d45b-54c7-be32-8c5c27082eb0'::uuid,'sleeve_length','Sleeve Length','measurement','variant',NULL,'cm',false,1),
  ('cd203376-19da-5f44-bbf5-54ef124cdcd5'::uuid,'neckline','Neckline','enum','product','["crew","v_neck","scoop","boat","square","collared","sweetheart","mock_neck","hooded","other"]'::jsonb,NULL,false,1),
  ('221df242-c0e7-5c7e-85ab-f45c4b304aa2'::uuid,'rise','Rise','enum','variant','["low","mid","high"]'::jsonb,NULL,false,1),
  ('956df4d5-b876-5536-a242-a58fac93eb4c'::uuid,'inseam','Inseam','measurement','variant',NULL,'cm',false,1) ON CONFLICT(code) DO NOTHING;
--> statement-breakpoint
DO $$ BEGIN IF EXISTS(SELECT 1 FROM (VALUES ('78a928a0-867d-59ba-b437-6638b7ba9b0a'::uuid,'size','Size','enum','variant','["XS","S","M","L","XL","XXL","0","2","4","6","8","10","12","14","16","18","20","24","26","28","30","32","34","36","38","40","42","44"]'::jsonb,NULL),
  ('afee88de-d8aa-58d2-bbad-21c41e7710ef'::uuid,'color','Color','enum','variant','["black","white","ivory","grey","navy","blue","green","olive","red","pink","purple","yellow","orange","brown","beige","multicolor"]'::jsonb,NULL),
  ('8253576f-93a4-593a-bb7c-3f445ad56b01'::uuid,'material_composition','Material Composition','text','product','["cotton","linen","hemp","silk","wool","cashmere","viscose","modal","lyocell","polyester","nylon","acrylic","elastane","recycled_polyester","recycled_cotton"]'::jsonb,NULL),
  ('c71795de-4377-57b8-b731-c50c2a5a7b1b'::uuid,'fit','Fit','enum','product','["regular","slim","relaxed","oversized","fitted","compression"]'::jsonb,NULL),
  ('c1b66fe5-6d72-5243-ae5a-17a58c9300a3'::uuid,'care_instructions','Care Instructions','multi_enum','product','["machine_wash_cold","machine_wash_warm","hand_wash","do_not_wash","do_not_bleach","tumble_dry_low","line_dry","dry_flat","iron_low","iron_medium","do_not_iron","dry_clean"]'::jsonb,NULL),
  ('e2dd3fcc-d45b-54c7-be32-8c5c27082eb0'::uuid,'sleeve_length','Sleeve Length','measurement','variant',NULL,'cm'),
  ('cd203376-19da-5f44-bbf5-54ef124cdcd5'::uuid,'neckline','Neckline','enum','product','["crew","v_neck","scoop","boat","square","collared","sweetheart","mock_neck","hooded","other"]'::jsonb,NULL),
  ('221df242-c0e7-5c7e-85ab-f45c4b304aa2'::uuid,'rise','Rise','enum','variant','["low","mid","high"]'::jsonb,NULL),
  ('956df4d5-b876-5536-a242-a58fac93eb4c'::uuid,'inseam','Inseam','measurement','variant',NULL,'cm')) AS e(id,code,label,value_type,scope_type,allowed_values,unit_code) LEFT JOIN catalogue.attributes a ON a.code=e.code WHERE a.id IS DISTINCT FROM e.id OR a.label IS DISTINCT FROM e.label OR a.value_type IS DISTINCT FROM e.value_type OR a.scope_type IS DISTINCT FROM e.scope_type OR a.allowed_values IS DISTINCT FROM e.allowed_values OR a.unit_code IS DISTINCT FROM e.unit_code OR a.schema_version IS DISTINCT FROM 1) THEN RAISE EXCEPTION 'REN2-54 attribute seed conflicts with existing taxonomy'; END IF; END; $$;