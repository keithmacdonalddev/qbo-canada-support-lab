'use strict'

const mongoose = require('mongoose')
const { ALL_PERMISSIONS } = require('../modules/rebuild-permissions')

const companyMembershipSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    realmId: {
      type: String,
      required: true,
      immutable: true,
    },
    role: {
      type: String,
      enum: ['lab-owner', 'operator', 'support-agent', 'reviewer'],
      required: true,
    },
    permissionOverrides: {
      type: [String],
      enum: ALL_PERMISSIONS,
      default: [],
    },
    status: {
      type: String,
      enum: ['active', 'suspended', 'retired'],
      default: 'active',
    },
    migratedFromLegacyRole: {
      type: String,
      enum: ['agent', 'supervisor', null],
      default: null,
    },
  },
  { timestamps: true }
)

companyMembershipSchema.index({ userId: 1, realmId: 1 }, { unique: true })
companyMembershipSchema.index({ realmId: 1, status: 1 })

module.exports = mongoose.model('CompanyMembership', companyMembershipSchema)
