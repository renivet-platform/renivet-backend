-- REN2-60: an accepted order records the point after which its external SKU
-- cannot be changed. The order-acceptance transaction must set sku_locked_at
-- in the same transaction that first references the variant.
ALTER TABLE catalogue.product_variants
  ADD COLUMN sku_locked_at timestamptz NULL;
--> statement-breakpoint

CREATE FUNCTION catalogue.ren2_60_guard_ordered_variant_sku()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.sku_locked_at IS NOT NULL THEN
    IF NEW.sku_locked_at IS DISTINCT FROM OLD.sku_locked_at
       OR NEW.sku IS DISTINCT FROM OLD.sku THEN
      RAISE EXCEPTION 'an ordered variant SKU and its lock are immutable'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.sku_locked_at IS NOT NULL AND NEW.sku IS DISTINCT FROM OLD.sku THEN
    RAISE EXCEPTION 'a variant SKU cannot change in the transaction that locks it'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER product_variants_ordered_sku_immutable
BEFORE UPDATE OF sku, sku_locked_at ON catalogue.product_variants
FOR EACH ROW
EXECUTE FUNCTION catalogue.ren2_60_guard_ordered_variant_sku();
