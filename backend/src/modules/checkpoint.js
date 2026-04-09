const Checkpoint = require('../models/Checkpoint');
const CheckpointEntity = require('../models/CheckpointEntity');

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

const PAGE_SIZE = 1000;

/**
 * Query all records of a given QBO entity type with pagination.
 */
async function queryAllPaginated(qbo, qboEntity) {
  const allRecords = [];
  let startPos = 1;

  while (true) {
    const result = await qbo.query(
      `SELECT * FROM ${qboEntity} STARTPOSITION ${startPos} MAXRESULTS ${PAGE_SIZE}`
    );
    const records = result.QueryResponse?.[qboEntity] || [];
    allRecords.push(...records);

    if (records.length < PAGE_SIZE) break; // no more pages
    startPos += PAGE_SIZE;
  }

  return allRecords;
}

/**
 * Create a checkpoint by snapshotting all key entity types from QBO.
 * Entities are stored in a separate collection to avoid document size limits.
 */
async function createCheckpoint(qbo, { userId, realmId, name, description }) {
  const entityCounts = {};

  // Create the checkpoint document first (without entity data)
  const checkpoint = await Checkpoint.create({
    userId,
    realmId,
    name,
    description: description || '',
    entityCounts: {},
  });

  try {
    for (const { key, qboEntity } of ENTITY_TYPES) {
      const records = await queryAllPaginated(qbo, qboEntity);
      entityCounts[key] = records.length;

      // Bulk insert into separate collection
      if (records.length > 0) {
        const docs = records.map((r) => ({
          checkpointId: checkpoint._id,
          entityType: key,
          qboId: r.Id,
          data: r,
        }));
        await CheckpointEntity.insertMany(docs, { ordered: false });
      }
    }

    checkpoint.entityCounts = entityCounts;
    await checkpoint.save();
  } catch (err) {
    // Clean up on failure
    await CheckpointEntity.deleteMany({ checkpointId: checkpoint._id });
    await Checkpoint.findByIdAndDelete(checkpoint._id);
    throw err;
  }

  return checkpoint;
}

/**
 * Load all entities for a checkpoint from the separate collection.
 * Returns { [entityType]: [{ qboId, data }] }
 */
async function loadCheckpointEntities(checkpointId) {
  const docs = await CheckpointEntity.find({ checkpointId }).lean();
  const grouped = {};

  for (const { key } of ENTITY_TYPES) {
    grouped[key] = [];
  }

  for (const doc of docs) {
    if (grouped[doc.entityType]) {
      grouped[doc.entityType].push({ qboId: doc.qboId, data: doc.data });
    }
  }

  return grouped;
}

/**
 * Compute a diff between two checkpoints.
 * Returns { [entityType]: { added: [], modified: [], deleted: [] } }
 */
async function diffCheckpoints(checkpointA, checkpointB) {
  const [entitiesA, entitiesB] = await Promise.all([
    loadCheckpointEntities(checkpointA._id),
    loadCheckpointEntities(checkpointB._id),
  ]);

  const diff = {};

  for (const { key } of ENTITY_TYPES) {
    const listA = entitiesA[key] || [];
    const listB = entitiesB[key] || [];

    const mapA = new Map(listA.map((e) => [e.qboId, e.data]));
    const mapB = new Map(listB.map((e) => [e.qboId, e.data]));

    const added = [];
    const deleted = [];
    const modified = [];

    for (const [id, dataB] of mapB) {
      if (!mapA.has(id)) {
        added.push({ qboId: id, data: dataB });
      }
    }

    for (const [id, dataA] of mapA) {
      if (!mapB.has(id)) {
        deleted.push({ qboId: id, data: dataA });
      }
    }

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
    if (field === 'MetaData') continue;
    const valA = objA?.[field];
    const valB = objB?.[field];
    if (JSON.stringify(valA) !== JSON.stringify(valB)) {
      changes.push({ field, before: valA, after: valB });
    }
  }

  return changes;
}

module.exports = { createCheckpoint, diffCheckpoints, loadCheckpointEntities, ENTITY_TYPES };
