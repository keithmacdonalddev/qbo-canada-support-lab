'use strict';
function stamp(value) {
  if (!(value instanceof Date) && typeof value !== 'string') return null;
  const number = new Date(value).getTime();
  return Number.isFinite(number) ? number : null;
}
function firstRequest(session, now = Date.now()) {
  const saved = stamp(session.reproduction?.firstSubmittedAt);
  if (saved !== null && saved <= now) return { firstSubmittedAt: new Date(saved).toISOString(), firstSubmissionSource: session.reproduction.firstSubmissionSource || 'recorded_request' };
  const messages = (session.messages || []).filter(message => message.role === 'user').map(message => stamp(message.timestamp)).filter(value => value !== null && value <= now);
  if (messages.length) return { firstSubmittedAt: new Date(messages.reduce((minimum, value) => Math.min(minimum, value), now)).toISOString(), firstSubmissionSource: 'earliest_saved_message' };
  const created = stamp(session.createdAt);
  if (created !== null && created <= now) return { firstSubmittedAt: new Date(created).toISOString(), firstSubmissionSource: 'session_created_estimate' };
  return { firstSubmittedAt: new Date(now).toISOString(), firstSubmissionSource: 'recorded_request' };
}
function caseTiming(session, now = Date.now()) {
  const run = session.reproduction;
  if (!run) return null;
  const validOrigin = value => stamp(value) !== null && stamp(value) <= now;
  const hasOrigin = validOrigin(run.firstSubmittedAt) || (session.messages || []).some(message => message.role === 'user' && validOrigin(message.timestamp)) || validOrigin(session.createdAt);
  if (!hasOrigin) return { available: false };
  const origin = firstRequest(session, now), first = stamp(origin.firstSubmittedAt);
  const started = stamp(run.startedAt);
  const completed = stamp(run.completedAt);
  const running = run.status === 'running';
  // A stopped or interrupted run without a finish receipt has no measured end.
  const end = running ? now : completed !== null && completed <= now && completed >= first && (started === null || completed >= started) ? completed : null;
  return { available: end !== null, ...origin, latestRunStartedAt: started !== null ? new Date(started).toISOString() : null,
    measuredThrough: end !== null ? new Date(end).toISOString() : null,
    elapsedMs: end !== null ? end - first : null, latestRunMs: end !== null && started !== null && started <= end ? end - started : null,
    includesWaiting: true, running,
    verifiedResult: !running && run.status === 'completed' && ['reproduced', 'not_reproduced', 'completed'].includes(run.outcome),
  };
}
module.exports = { firstRequest, caseTiming };
