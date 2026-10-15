'use strict';
const { hash } = require('./business-calendar');
const { scoped } = require('./qbo-write-contract');
const { validateDraftInput, buildDraftDefinition, problem } = require('./blueprint-draft');
// Private transaction participant. Callers establish current owner authority and
// storage readiness before invoking it; HTTP bodies cannot supply a session.
async function writeBlueprintDraft({ Versions, Sequences, Audits, scope, actorId, ownerId, input, session }) {
  scope = scoped(scope); input = validateDraftInput(input);
  if (!session?.inTransaction?.() || ![actorId, ownerId].every(id => /^[a-f0-9]{24}$/.test(id || '')) || input.connectionId !== scope.connectionId) throw problem('An exact authorized draft transaction is required.', 409);
  const filter = { realmId: scope.realmId, environment: scope.environment, contractVersion: 2 }, requestHash = hash(input);
  const id = hash({ ...filter, connectionId: input.connectionId, actorId, requestKey: input.requestKey }).slice(0, 24), auditId = hash({ blueprintDraft: id, event: 'saved' }).slice(0, 24);
  const existing = await Versions.findOne({ _id: id, ...filter }).session(session).lean();
  if (existing) {
    if (existing.requestHash !== requestHash || String(existing.createdBy) !== actorId) throw problem('This save identifier was already used for different business settings.', 409);
    return existing;
  }
  const previous = await Versions.findOne(filter).sort({ version: -1 }).session(session).lean();
  if ((previous?.contentHash || null) !== input.baseHash) throw problem('A newer business plan was saved. Reload it before saving your changes.', 409);
  const last = await Versions.findOne({ realmId: scope.realmId }).sort({ version: -1 }).session(session).lean();
  if (last && (!Number.isSafeInteger(last.version) || last.version < 1 || last.version >= Number.MAX_SAFE_INTEGER)) throw problem('Business plan version history needs repair before saving.', 409);
  await Sequences.updateOne({ _id: scope.realmId }, { $max: { value: last?.version || 0 } }, { upsert: true, session });
  const sequence = await Sequences.findOneAndUpdate({ _id: scope.realmId }, { $inc: { value: 1 } }, { new: true, session }).lean();
  if (!Number.isSafeInteger(sequence?.value) || sequence.value < 1) throw problem('Business plan version allocation needs repair before saving.', 409);
  const definition = buildDraftDefinition(input), contentHash = hash(definition);
  const [document] = await Versions.create([{ _id: id, ...filter, version: sequence.value, connectionId: scope.connectionId, status: 'draft', definition, contentHash, requestHash, requestKey: input.requestKey, auditId, createdBy: actorId }], { session });
  await Audits.create([{ _id: auditId, userId: ownerId, ...(actorId !== ownerId ? { actorUserId: actorId } : {}), realmId: scope.realmId, action: 'Business plan draft saved', actionType: 'manual', outcome: 'success', afterState: { blueprintId: id, version: sequence.value, environment: scope.environment, contentHash, previousContentHash: input.baseHash } }], { session });
  return document.toObject ? document.toObject() : document;
}
module.exports = { writeBlueprintDraft };
