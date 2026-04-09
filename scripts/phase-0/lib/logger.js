const fs = require('fs');
const path = require('path');

const logsDir = path.resolve(__dirname, '../../../logs/phase-0');
fs.mkdirSync(logsDir, { recursive: true });

const logFile = path.join(logsDir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
const stream = fs.createWriteStream(logFile, { flags: 'a' });

function log(level, label, data) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    label,
    ...(data !== undefined && { data }),
  };
  const line = JSON.stringify(entry);
  stream.write(line + '\n');
  if (level === 'error') {
    console.error(`[${label}]`, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  } else {
    console.log(`[${label}]`, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  }
}

module.exports = {
  info: (label, data) => log('info', label, data),
  error: (label, data) => log('error', label, data),
  result: (testId, status, summary, details) => {
    log('result', testId, { status, summary, ...(details && { details }) });
  },
  logFile,
};
