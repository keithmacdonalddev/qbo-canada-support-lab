const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const express = require('express');
const cors = require('cors');
const connectDB = require('./config/database');
const config = require('./config/index');
const errorHandler = require('./middleware/errorHandler');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/qbo', require('./routes/qbo'));
app.use('/api/company', require('./routes/company'));
app.use('/api/seed', require('./routes/seed'));
app.use('/api/audit', require('./routes/audit'));
app.use('/api/generate', require('./routes/generate'));
app.use('/api/checkpoint', require('./routes/checkpoint'));
app.use('/api/explore', require('./routes/explore'));
app.use('/api/issuepacks', require('./routes/issuepacks'));
const aiRoutes = require('./routes/ai');
app.use('/api/ai', aiRoutes.router);

// Wire SSE emitter from routes into the orchestrator (breaks circular dep)
const orchestrator = require('./modules/ai-orchestrator');
orchestrator.bindSSE(aiRoutes.emitSSE);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handling (must be after routes)
app.use(errorHandler);

async function start() {
  await connectDB();

  // Seed built-in issue packs
  const { seedIssuePacks } = require('./modules/issuepack-seeder');
  await seedIssuePacks();

  // Recover stale in_progress jobs from prior crashes
  const GenerationRun = require('./models/GenerationRun');
  const SeedRun = require('./models/SeedRun');
  const IssuePackRun = require('./models/IssuePackRun');
  const staleGenRuns = await GenerationRun.updateMany(
    { status: 'in_progress' },
    { $set: { status: 'failed', completedAt: new Date(), 'progress.phase': 'error', 'progress.detail': 'Server restarted — job interrupted' } }
  );
  const staleSeedRuns = await SeedRun.updateMany(
    { status: 'in_progress' },
    { $set: { status: 'failed', completedAt: new Date(), 'progress.phase': 'error', 'progress.detail': 'Server restarted — job interrupted' } }
  );
  const stalePackRuns = await IssuePackRun.updateMany(
    { status: 'in_progress' },
    { $set: { status: 'failed', completedAt: new Date() } }
  );
  const AIPlan = require('./models/AIPlan');
  const stalePlans = await AIPlan.updateMany(
    { status: 'executing' },
    { $set: { status: 'failed', completedAt: new Date() } }
  );
  const recovered = staleGenRuns.modifiedCount + staleSeedRuns.modifiedCount + stalePackRuns.modifiedCount + stalePlans.modifiedCount;
  if (recovered > 0) {
    console.log(`[startup] Recovered ${recovered} stale in_progress job(s)`);
  }

  app.listen(config.port, () => {
    console.log(`Server running on port ${config.port}`);
  });
}

start();
