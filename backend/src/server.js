const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const connectDB = require('./config/database');
const config = require('./config/index');
const { createApp } = require('./app');

async function start() {
  await connectDB();

  if (config.features.legacyStartupMaintenance) {
    const { seedIssuePacks } = require('./modules/issuepack-seeder');
    await seedIssuePacks();

    const GenerationRun = require('./models/GenerationRun');
    const SeedRun = require('./models/SeedRun');
    const IssuePackRun = require('./models/IssuePackRun');
    const AIPlan = require('./models/AIPlan');
    const [staleGenRuns, staleSeedRuns, stalePackRuns, stalePlans] = await Promise.all([
      GenerationRun.updateMany(
        { status: 'in_progress' },
        { $set: { status: 'failed', completedAt: new Date(), 'progress.phase': 'error', 'progress.detail': 'Server restarted — job interrupted' } }
      ),
      SeedRun.updateMany(
        { status: 'in_progress' },
        { $set: { status: 'failed', completedAt: new Date(), 'progress.phase': 'error', 'progress.detail': 'Server restarted — job interrupted' } }
      ),
      IssuePackRun.updateMany(
        { status: 'in_progress' },
        { $set: { status: 'failed', completedAt: new Date() } }
      ),
      AIPlan.updateMany(
        { status: 'executing' },
        { $set: { status: 'failed', completedAt: new Date() } }
      ),
    ]);
    const recovered = staleGenRuns.modifiedCount + staleSeedRuns.modifiedCount + stalePackRuns.modifiedCount + stalePlans.modifiedCount;
    if (recovered > 0) console.log(`[startup] Recovered ${recovered} stale in_progress job(s)`);
  } else {
    console.log('[startup] Legacy issue-pack seeding and stale-run rewrites are disabled by server policy');
  }

  const app = createApp();
  app.listen(config.port, () => {
    console.log(`Server running on port ${config.port}`);
  });
}

if (require.main === module) {
  start().catch((error) => {
    console.error('[startup] Failed to start server:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { start };
