-- REN2-61 request receipts and field provenance are append-only audit data.
CREATE TRIGGER product_mutation_receipts_immutable
BEFORE UPDATE OR DELETE ON catalogue.product_mutation_receipts
FOR EACH ROW EXECUTE FUNCTION catalogue.reject_mutation_of_immutable_row();
--> statement-breakpoint

CREATE TRIGGER product_field_lineage_immutable
BEFORE UPDATE OR DELETE ON catalogue.product_field_lineage
FOR EACH ROW EXECUTE FUNCTION catalogue.reject_mutation_of_immutable_row();
