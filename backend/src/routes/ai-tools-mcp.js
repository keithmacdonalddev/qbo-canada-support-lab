'use strict';

// MCP endpoint that Codex CLI runs call for this app's AI tools. There is no
// JWT here: each run's random session token (ai-tool-bridge) is the only
// credential, and an unknown or ended token gets a plain 404.

const express = require('express');
const { handleMcpRequest } = require('../modules/ai-tool-bridge');

const router = express.Router();

function bearerToken(req) {
  const match = /^Bearer\s+([a-f0-9]{64})$/i.exec(String(req.headers.authorization || '').trim());
  return match ? match[1].toLowerCase() : '';
}

router.post('/', async (req, res) => {
  const token = bearerToken(req);
  if (!token) return res.status(404).json({ error: 'Not found' });
  const { status, json } = await handleMcpRequest(token, req.body);
  if (json === null) return res.status(status).end();
  return res.status(status).json(json);
});

// Streamable HTTP clients may probe for an event stream or close a session;
// this endpoint answers with JSON only.
router.get('/', (_req, res) => res.status(405).set('Allow', 'POST').end());
router.delete('/', (_req, res) => res.status(200).end());

module.exports = router;
