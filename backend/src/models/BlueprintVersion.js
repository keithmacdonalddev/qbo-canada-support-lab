'use strict'

const mongoose = require('mongoose')
const { hash } = require('../modules/business-calendar')
const { validateBlueprintDefinition } = require('../modules/blueprint-validator')

const blueprintVersionSchema = new mongoose.Schema(
  {
    contractVersion: { type: Number, enum: [1, 2], default: 1 },
    environment: { type: String, enum: ['sandbox', 'production'] },
    connectionId: mongoose.Schema.Types.ObjectId,
    contentHash: String,
    requestHash: String,
    requestKey: String,
    auditId: mongoose.Schema.Types.ObjectId,
    realmId: { type: String, required: true, immutable: true },
    version: { type: Number, required: true, min: 1, validate: Number.isSafeInteger, immutable: true },
    status: {
      type: String,
      enum: ['draft', 'published', 'retired'],
      default: 'draft',
    },
    definition: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    validation: {
      valid: { type: Boolean, default: false },
      errors: { type: [mongoose.Schema.Types.Mixed], default: [] },
      validatedAt: { type: Date, default: null },
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    publishedAt: { type: Date, default: null },
  },
  { timestamps: true, autoIndex: false, autoCreate: false }
)

blueprintVersionSchema.index({ realmId: 1, version: 1 }, { unique: true })
blueprintVersionSchema.index({ realmId: 1, status: 1 })

blueprintVersionSchema.pre('validate', function validateDefinition() {
  const result = validateBlueprintDefinition(this.definition)
  if (this.contractVersion === 2) {
    for (const key of ['environment', 'connectionId', 'contentHash', 'requestHash', 'requestKey', 'auditId']) if (!this[key]) this.invalidate(key, 'Saved business plan metadata is required')
    if (this.status !== 'draft') this.invalidate('status', 'This contract only saves drafts; activation is a separate operation')
    if (this.contentHash !== hash(this.definition)) this.invalidate('contentHash', 'Business plan content does not match its fingerprint')
  }
  this.validation = {
    valid: result.valid,
    errors: result.errors,
    validatedAt: new Date(),
  }
  if (!result.valid) {
    this.invalidate('definition', 'Blueprint definition failed the rebuild validation contract')
  }
  if (this.status === 'published' && !this.publishedAt) {
    this.invalidate('publishedAt', 'Published blueprints require a publishedAt timestamp')
  }
})

// Saved snapshots are append-only. There is no mutable draft API to preserve.
blueprintVersionSchema.pre('save', function () { if (!this.isNew) throw new Error('Save a new business plan version instead of editing history') })
blueprintVersionSchema.pre('deleteOne', { document: true, query: false }, function () { throw new Error('Business plan history is append-only') })
for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete']) {
  blueprintVersionSchema.pre(operation, function () { throw new Error('Business plan history is append-only') })
}

module.exports = mongoose.model('BlueprintVersion', blueprintVersionSchema)
