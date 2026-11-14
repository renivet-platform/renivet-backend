# Apparel pilot taxonomy — Pilot v1

- **Dataset ID:** `renivet.catalog-taxonomy.apparel-pilot-v1`
- **Version:** `1`
- **Owner:** Catalog Operations
- **Approval:** Owner approved eight apparel categories, their shared fields, and the specified category-specific fields for pilot use.

The fixture defines a non-leaf `apparel` parent and eight leaf categories: T-shirts and tops, shirts and blouses, kurtas and tunics, dresses and jumpsuits, trousers and jeans, skirts and shorts, jackets and outerwear, and activewear. Category and attribute IDs are deterministic UUIDs derived from the versioned stable codes; later changes must use a new dataset/schema version rather than reuse an ID for changed meaning.

The shared fields are size and color on variants; material composition, fit, and care instructions on products. Material composition is free text because the current W2 attribute validator has no structured fiber-percentage type; the fixture supplies a controlled fiber vocabulary for entry guidance. Sleeve length, neckline, rise, and inseam are added only to relevant categories. Measurement units use centimeters.

This pilot adds no legal, label, or certification rules. It relies only on currently approved W2 compliance policy. Existing publication validation must fail closed when an applicable approved requirement or required evidence is missing. Legal/counsel or merchant-specific obligations remain a release decision and must not be inferred from this fixture.

## Changes and retirement

Additions or semantic changes require a new immutable dataset version, reviewed by Catalog Operations and published via the existing guarded taxonomy maker-checker lifecycle. Never mutate a published category schema or silently repurpose a stable code/ID. Retirement uses the existing taxonomy availability controls after checking pinned product revisions and references; historical snapshots remain available for audit.

## Loading

This repository change adds a versioned source fixture only. It does not insert category rows or publish schemas in an existing database. A deployment must load it through the reviewed taxonomy lifecycle using authorized global W1 permissions, independent maker/checker users, and the applicable disposable/staging migration evidence.