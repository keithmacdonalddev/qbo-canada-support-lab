'use strict'

const mongoose = require('mongoose')
const { validateBlueprintDefinition } = require('../modules/blueprint-validator')

const blueprintVersionSchema = new mongoose.Schema(
  {
    realmId: { type: String, required: true, immutable: true },
    version: { type: Number, required: true, min: 1, immutable: true },
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
  { timestamps: true }
)

blueprintVersionSchema.index({ realmId: 1, version: 1 }, { unique: true })
blueprintVersionSchema.index({ realmId: 1, status: 1 })

blueprintVersionSchema.pre('validate', function validateDefinition() {
  const result = validateBlueprintDefinition(this.definition)
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

module.exports = mongoose.model('BlueprintVersion', blueprintVersionSchema)
