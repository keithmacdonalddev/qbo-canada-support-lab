const dns = require('node:dns');
const mongoose = require('mongoose');
const config = require('./index');

async function connectDB() {
  // Override DNS for Atlas SRV resolution if configured
  const dnsServers = process.env.MONGODB_DNS_SERVERS;
  if (dnsServers) {
    const servers = dnsServers.split(',').map(s => s.trim()).filter(Boolean);
    if (servers.length) {
      dns.setServers(servers);
      console.log(`MongoDB DNS override: ${servers.join(', ')}`);
    }
  }

  try {
    const conn = await mongoose.connect(config.mongoUri);
    console.log(`MongoDB connected: ${conn.connection.host}`);
  } catch (err) {
    console.error(`MongoDB connection error: ${err.message}`);
    process.exit(1);
  }
}

module.exports = connectDB;
