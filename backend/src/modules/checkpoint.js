const Checkpoint = require('../models/Checkpoint');

/**
 * Entity types to snapshot and their QBO query entity names.
 */
const ENTITY_TYPES = [
  { key: 'customers', qboEntity: 'Customer' },
  { key: 'invoices', qboEntity: 'Invoice' },
  { key: 'payments', qboEntity: 'Payment' },
  { key: 'creditMemos', qboEntity: 'CreditMemo' },
  { key: 'bills', qboEntity: 'Bill' },
  { key: 'billPayments', qboEntity: 'BillPayment' },
  { key: 'vendorCredits', qboEntity: 'VendorCredit' },
  { key: 'items', qboEntity: 'Item' },
  { key: 'accounts', qboEntity: 'Account' },
  { key: 'journalEntries', qboEntity: 'JournalEntry' },
];

/**
 * Query all records of a given QBO entity type (paging up to 1000).
 */
async function queryAll(qbo, qboEntity) {
  const result = await qbo.query(
    `SELECT * FROM ${qboEntity} MAXRESULTS 1000`
  );
  return result.QueryResponse?.[qboEntity] || [];
}

/**
 * Create a checkpoint by snapshotting all key entity types from QBO.
 */
async function createCheckpoint(qbo, { userId, realmId, name, description }) {
  const entities = {};
  const entityCounts = {};

  for (const { key, qboEntity } of ENTITY_TYPES) {
    const records = await queryAll(qbo, qboEntity);
    entities[key] = records.map((r) => ({ qboId: r.Id, data: r }));
    entityCounts[key] = records.length;
  }

  const checkpoint = await Checkpoint.create({
    userId,
    realmId,
    name,
    description: description || '',
    entities,
    entityCounts,
  });

  return checkpoint;
}

/**
 * Compute a diff between two checkpoints.
 * Returns { [entityType]: { added: [], modified: [], deleted: [] } }
 */
function diffCheckpoints(checkpointA, checkpointB) {
  const diff = {};

  for (const { key } of ENTITY_TYPES) {
    const listA = checkpointA.entities?.[key] || [];
    const listB = checkpointB.entities?.[key] || [];

    const mapA = new Map(listA.map((e) => [e.qboId, e.data]));
    const mapB = new Map(listB.map((e) => [e.qboId, e.data]));

    const added = [];
    const deleted = [];
    const modified = [];

    // Entities in B but not in A = added
    for (const [id, dataB] of mapB) {
      if (!mapA.has(id)) {
        added.push({ qboId: id, data: dataB });
      }
    }

    // Entities in A but not in B = deleted
    for (const [id, dataA] of mapA) {
      if (!mapB.has(id)) {
        deleted.push({ qboId: id, data: dataA });
      }
    }

    // Entities in both = check for modifications
    for (const [id, dataA] of mapA) {
      if (mapB.has(id)) {
        const dataB = mapB.get(id);
        const changes = diffFields(dataA, dataB);
        if (changes.length > 0) {
          modified.push({ qboId: id, changes });
        }
      }
    }

    if (added.length || modified.length || deleted.length) {
      diff[key] = { added, modified, deleted };
    }
  }

  return diff;
}

/**
 * Compare two objects field-by-field, returning changed fields.
 * Skips MetaData (always changes) for cleaner diffs.
 */
function diffFields(objA, objB) {
  const changes = [];
  const allKeys = new Set([...Object.keys(objA || {}), ...Object.keys(objB || {})]);

  for (const field of allKeys) {
    if (field === 'MetaData') continue; // skip noisy timestamp changes
    const valA = objA?.[field];
    const valB = objB?.[field];
    if (JSON.stringify(valA) !== JSON.stringify(valB)) {
      changes.push({ field, before: valA, after: valB });
    }
  }

  return changes;
}

module.exports = { createCheckpoint, diffCheckpoints, ENTITY_TYPES };
