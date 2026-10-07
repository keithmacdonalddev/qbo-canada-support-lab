'use strict';
const mongoose = require('mongoose');
const { hash } = require('./business-calendar');
const { validateDraftInput, buildDraftDefinition, draftView, proposalView, MAPPINGS, problem } = require('./blueprint-draft');
const { createBusinessTransaction } = require('./business-transaction');
const { createContextService } = require('./rebuild-context');
const BlueprintVersion = require('../models/BlueprintVersion');
const BlueprintSequence = require('../models/BlueprintSequence');
const AuditLog = require('../models/AuditLog');
async function blueprintStorageReady(connection = mongoose.connection, versions = BlueprintVersion.collection) {
  if (connection.readyState !== 1) return { ready: false, reason: 'The app database is unavailable.' };
  try {
    const names = [versions.name, BlueprintSequence.collection.name, AuditLog.collection.name];
    const collections = await connection.db.listCollections({ name: { $in: names } }, { nameOnly: true }).toArray();
    if (collections.length !== names.length) return { ready: false, reason: 'Business plan storage needs to be prepared before saving.' };
    const indexes = await versions.indexes();
    if (!indexes.some(index => !index.partialFilterExpression && !index.sparse && index.unique === true && index.key.realmId === 1 && index.key.version === 1 && Object.keys(index.key).length === 2)) return { ready: false, reason: 'Business plan version protection has not been installed.' };
    const hello = await connection.db.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== 'isdbgrid') return { ready: false, reason: 'Business plans require transaction-capable database storage.' };
    return { ready: true, reason: null };
  } catch { return { ready: false, reason: 'Business plan storage readiness could not be verified.' }; }
}
function createBlueprintDraftService(dependencies = {}) {
  const Versions = dependencies.Versions || BlueprintVersion;
  const Sequences = dependencies.Sequences || BlueprintSequence;
  const Audits = dependencies.Audits || AuditLog;
  const transaction = dependencies.transaction || createBusinessTransaction(mongoose.connection);
  const resolve = dependencies.resolve || createContextService().resolve;
  const storageReady = dependencies.storageReady || blueprintStorageReady;
  const scopeOf = context => ({ realmId: context.connection.realmId, environment: context.environment, contractVersion: 2 });
  async function contextFor(user, permission) {
    const context = await resolve(user);
    if (!context.connection?.connected || !context.connection.connectionId) throw problem('Connect a company before preparing its business plan.', 409);
    if (!context.membership.permissions.includes(permission)) throw problem('Your company role cannot perform this business plan action.', 403);
    return context;
  }
  const latest = (context, session) => {
    const query = Versions.findOne(scopeOf(context)).sort({ version: -1 });
    return (session ? query.session(session) : query).lean();
  };
  async function read(user) {
    const { masterRequirements } = require('./business-master-data');
    const context = await contextFor(user, 'blueprint.read');
    const [saved, storage] = await Promise.all([latest(context), storageReady()]);
    return { realmId: context.connection.realmId, environment: context.environment, connectionId: context.connection.connectionId, companyName: context.connection.companyName,
      draft: draftView(saved, context.connection.connectionId), proposal: proposalView(), mappingDefinitions: MAPPINGS,
      masterDefinitions: Object.fromEntries(['development', 'flagship'].map(volumeProfile => [volumeProfile, masterRequirements({ ...proposalView().business, volumeProfile })])),
      canSave: context.membership.permissions.includes('blueprint.manage') && storage.ready, storage,
      permissionToSave: context.membership.permissions.includes('blueprint.manage'), activated: false,
      activationNeeds: ['Verified activity rules and exact company mappings', 'Reviewed starting balances and existing test-record ownership', 'Complete operation execution and report verification'],
    };
  }
  async function save(user, body) {
    const input = validateDraftInput(body);
    const initial = await contextFor(user, 'blueprint.manage');
    if (input.connectionId !== initial.connection.connectionId) throw problem('The connected company changed. Reload its business plan before saving.', 409);
    const readiness = await storageReady();
    if (!readiness.ready) throw problem(readiness.reason, 409);
    const definition = buildDraftDefinition(input), contentHash = hash(definition);
    const requestHash = hash(input);
    const actorId = String(user.actorId || user.id);
    const id = new mongoose.Types.ObjectId(hash({ ...scopeOf(initial), connectionId: input.connectionId, actorId, requestKey: input.requestKey }).slice(0, 24));
    const auditId = new mongoose.Types.ObjectId(hash({ blueprintDraft: String(id), event: 'saved' }).slice(0, 24));
    const result = await transaction(async session => {
      const context = await contextFor(user, 'blueprint.manage');
      if (context.connection.connectionId !== initial.connection.connectionId || context.environment !== initial.environment || context.connection.realmId !== initial.connection.realmId) throw problem('The connected company changed. Reload its business plan.', 409);
      const existing = await Versions.findOne({ _id: id, ...scopeOf(context) }).session(session).lean();
      if (existing) {
        if (existing.requestHash !== requestHash || String(existing.createdBy) !== actorId) throw problem('This save identifier was already used for different business settings.', 409);
        return existing;
      }
      const previous = await latest(context, session);
      if ((previous?.contentHash || null) !== input.baseHash) throw problem('A newer business plan was saved. Reload it before saving your changes.', 409);
      // The established unique index numbers versions across a realm, including legacy records.
      const last = await Versions.findOne({ realmId: context.connection.realmId }).sort({ version: -1 }).session(session).lean();
      if (last && (!Number.isSafeInteger(last.version) || last.version < 1 || last.version >= Number.MAX_SAFE_INTEGER)) throw problem('Business plan version history needs repair before saving.', 409);
      await Sequences.updateOne({ _id: context.connection.realmId }, { $max: { value: last?.version || 0 } }, { upsert: true, session });
      const sequence = await Sequences.findOneAndUpdate({ _id: context.connection.realmId }, { $inc: { value: 1 } }, { new: true, session }).lean();
      if (!Number.isSafeInteger(sequence?.value) || sequence.value < 1) throw problem('Business plan version allocation needs repair before saving.', 409);
      const [document] = await Versions.create([{ _id: id, ...scopeOf(context), version: sequence.value, connectionId: context.connection.connectionId,
        status: 'draft', definition, contentHash, requestHash, requestKey: input.requestKey, auditId, createdBy: actorId }], { session });
      await Audits.create([{ _id: auditId, userId: user.id, actorUserId: actorId !== String(user.id) ? actorId : undefined,
        realmId: context.connection.realmId, action: 'Business plan draft saved', actionType: 'manual', outcome: 'success',
        afterState: { blueprintId: String(id), version: sequence.value, environment: context.environment, contentHash, previousContentHash: input.baseHash },
      }], { session });
      return document.toObject ? document.toObject() : document;
    });
    return { realmId: initial.connection.realmId, environment: initial.environment, connectionId: initial.connection.connectionId, draft: draftView(result, initial.connection.connectionId) };
  }
  return { read, save, contextFor };
}
module.exports = { createBlueprintDraftService, blueprintStorageReady };
