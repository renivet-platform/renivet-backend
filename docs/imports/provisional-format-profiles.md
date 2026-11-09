# Provisional catalog import profiles

REN2-76 adds versioned, replaceable workbook profiles for the two supplied examples. They are development aids, not declarations of official Shopify or Unicommerce formats. The XLSX files themselves stay outside Git; tests use small synthetic rows with the same column names.

| Profile ID | Version | Status | Layout used |
| --- | --- | --- | --- |
| `shopify-universal-xlsx-provisional` | `0.1.0` | Provisional | `MASTER DATA` sheet; `UNIQUE PRODUCT CODE` / `EAN`, `STYLE NAME`, `Shopify Handle`, color/size, and source fields |
| `unicommerce-comprehensive-xlsx-illustrative` | `0.1.0` | Illustrative | `Uniware_API_Items` for item rows and `Inventory_Snapshot` for separate facility stock observations |

The supplied Shopify workbook was recognized locally but contains more than the allowed 5,000 catalog rows, so the full workbook was rejected. Split it into smaller authorized files or use a later explicit batching policy. The supplied Unicommerce workbook parsed as an illustrative template; its own `START_HERE` sheet says it is not an official live-account export. Neither result counts as authentic-vendor-format acceptance evidence.

Source MRP and image URLs are retained as source fields only. Inventory is emitted as a separate observation, never a catalog write or stock movement. A source SKU is not assumed to be a product grouping key. Formula cells are not evaluated. Invalid catalog rows receive row-numbered errors while valid rows can still be mapped.

## Replacing these profiles later

When authentic exports are available, add a new profile ID and version rather than changing the mapping for `0.1.0`. Add sanitized, minimal fixtures derived from approved exports, assert their header detection and field mappings, and keep any proprietary full exports out of the repository. The bounded parser, 5,000-row policy, tenant boundary, and staging behavior remain independent of vendor-specific column names.
