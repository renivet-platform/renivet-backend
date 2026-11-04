-- REN2-62: record idempotent create, update, and deactivate SKU variant mutations.
ALTER TABLE catalogue.product_mutation_receipts
  DROP CONSTRAINT product_mutation_receipts_operation_check;
--> statement-breakpoint

ALTER TABLE catalogue.product_mutation_receipts
  ADD CONSTRAINT product_mutation_receipts_operation_check
  CHECK (operation IN (
    'createBrandProduct', 'updateBrandProduct',
    'createProductVariant', 'updateProductVariant', 'deactivateProductVariant'
  ));
