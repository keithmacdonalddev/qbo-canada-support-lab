#!/usr/bin/env node
'use strict';

// Share the connected QuickBooks company with another app account, or stop sharing it.
// See docs/architecture/shared-company-access.md.
//
//   node scripts/company-access.js list
//   node scripts/company-access.js grant <email> [--role operator]
//   node scripts/company-access.js revoke <email>
//
// The company is the one with the most recent active connection. Writes only
// CompanyMembership rows in MongoDB; never touches QuickBooks or tokens.

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const dns = require('dns');
if (process.env.MONGODB_DNS_SERVERS) {
  dns.setServers(process.env.MONGODB_DNS_SERVERS.split(',').map((s) => s.trim()).filter(Boolean));
}
const mongoose = require('mongoose');
const config = require('../backend/src/config');
const Connection = require('../backend/src/models/Connection');
const CompanyMembership = require('../backend/src/models/CompanyMembership');
const User = require('../backend/src/models/User');

const ROLES = ['lab-owner', 'operator', 'support-agent', 'reviewer'];

async function main() {
  const [command, email, ...rest] = process.argv.slice(2);
  const roleFlag = rest.indexOf('--role');
  const role = roleFlag >= 0 ? rest[roleFlag + 1] : 'operator';
  if (!['list', 'grant', 'revoke'].includes(command) || (command !== 'list' && !email) || !ROLES.includes(role)) {
    console.error('Usage: node scripts/company-access.js list | grant <email> [--role operator] | revoke <email>');
    process.exitCode = 2;
    return;
  }

  await mongoose.connect(config.mongoUri);
  try {
    const connection = await Connection.findOne({ status: 'active' }).sort({ updatedAt: -1 }).select('userId realmId companyName').lean();
    if (!connection) throw new Error('No active QuickBooks connection to share.');
    const owner = await User.findById(connection.userId).select('email').lean();
    console.log(`Company: ${connection.companyName || '(unnamed)'} (realm ${connection.realmId}), owner ${owner?.email || connection.userId}, ${config.qbo.environment}`);

    if (command !== 'list') {
      const user = await User.findOne({ email: email.toLowerCase() }).select('_id email').lean();
      if (!user) throw new Error(`No app account with email ${email}. Sign in with it once first.`);
      if (String(user._id) === String(connection.userId)) throw new Error('That account already owns the connection.');
      const membership = await CompanyMembership.findOneAndUpdate(
        { userId: user._id, realmId: connection.realmId },
        command === 'grant' ? { $set: { role, status: 'active' } } : { $set: { status: 'retired' } },
        { upsert: command === 'grant', new: true, setDefaultsOnInsert: true, runValidators: true },
      );
      if (command === 'grant') {
        console.log(`Granted ${user.email} (${role}).`);
        console.log('Note: roles are not enforced on legacy routes yet. This account can approve and run writes to this company.');
      } else {
        console.log(membership ? `Revoked ${user.email}.` : `${user.email} had no access to this company.`);
      }
    }

    const members = await CompanyMembership.find({ realmId: connection.realmId }).populate('userId', 'email').lean();
    if (!members.length) console.log('No other accounts share this company.');
    for (const m of members) console.log(`  ${m.userId?.email || m.userId}  ${m.role}  ${m.status}`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
