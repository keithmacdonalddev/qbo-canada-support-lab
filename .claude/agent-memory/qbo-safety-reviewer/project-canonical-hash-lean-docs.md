---
name: project-canonical-hash-lean-docs
description: business-calendar canonical()/hash() throws on non-plain values (Date, ObjectId); hashing a whole Mongoose lean() row fails in production while plain-object test fixtures pass.
metadata:
  type: project
---

`canonical()` in backend/src/modules/business-calendar.js accepts only plain JSON (null/bool/string/finite number/array/plain object) and throws 'Blueprint values must be plain JSON' otherwise. Mongoose `.lean()` rows keep native `Date` for timestamp fields (createdAt/updatedAt with `timestamps: true`) and ObjectId for default `_id`.

**Why:** In the 2026-10-29 review of PO receiving (policy v5), business-readback.js hashed `taxPolicy.purchaseOrderReceipt.original` (a lean BusinessPopulationRecord row, timestamps: true) into the Bill's evidenceHash. The unit test used a hand-built plain `row`, so it passed; in production the post-write verification would throw after the QuickBooks Bill already exists.

**How to apply:** When a diff calls `hash(...)`/`canonical(...)` on anything loaded from Mongo, check whether it is a whole document (or contains Date/ObjectId fields) and whether the test fixture is a plain literal. Flag post-write verification paths as high because they strand a real QBO write. See [[project-live-production-company]].
