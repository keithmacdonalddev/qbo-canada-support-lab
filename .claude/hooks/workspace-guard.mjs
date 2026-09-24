// Compatibility entry; active wiring uses the shared bounded policy.
import { createRequire } from 'node:module';
const { main } = createRequire(import.meta.url)('../../scripts/agent-harness/workflow.cjs');
await main('pre-tool-use').catch(() => { console.error('Coding harness inspection failed.'); process.exitCode = 2; });
