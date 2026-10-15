const mongoose = require('mongoose');
const config = require('./index');

async function connectDB() {
  require('../modules/storage-target').configureDatabaseDns();

  try {
    const conn = await mongoose.connect(config.mongoUri);
    console.log(`MongoDB connected: ${conn.connection.host}`);
  } catch (err) {
    console.error(`MongoDB connection error: ${err.message}`);
    process.exit(1);
  }
}

module.exports = connectDB;
