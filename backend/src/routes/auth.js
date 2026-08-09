const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../config');
const User = require('../models/User');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

/**
 * Helper -- sign a JWT for the given user document.
 */
function signToken(user) {
  return jwt.sign(
    { id: user._id, email: user.email, role: user.role },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );
}

function isDevAccessEmail(email) {
  return config.devAccess.enabled && email.toLowerCase() === config.devAccess.email;
}

/**
 * GET /dev-access
 * Returns the intentionally public shared tester credentials in local development.
 */
router.get('/dev-access', (_req, res) => {
  if (!config.devAccess.enabled) {
    return res.json({ enabled: false });
  }

  return res.json({
    enabled: true,
    email: config.devAccess.email,
    password: config.devAccess.password,
  });
});

/**
 * POST /register
 * Body: { email, password, displayName, role? }
 */
router.post('/register', async (req, res) => {
  try {
    const { email, password, displayName } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    if (isDevAccessEmail(email)) {
      return res.status(409).json({ error: 'Use the tester credentials shown on the sign-in page' });
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const user = await User.create({
      email,
      password,
      displayName: displayName || email.split('@')[0],
      role: 'agent',
    });

    const token = signToken(user);

    return res.status(201).json({
      token,
      user: user.toJSON(),
    });
  } catch (err) {
    console.error('[auth/register]', err.message);
    return res.status(500).json({ error: 'Registration failed' });
  }
});

/**
 * POST /login
 * Body: { email, password }
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const normalizedEmail = email.toLowerCase();
    const isDevAccessAttempt = isDevAccessEmail(normalizedEmail)
      && password === config.devAccess.password;

    // Explicitly select password since toJSON transform strips it.
    let user = await User.findOne({ email: normalizedEmail }).select('+password');

    if (isDevAccessAttempt) {
      if (!user) {
        user = await User.create({
          email: config.devAccess.email,
          password: config.devAccess.password,
          displayName: config.devAccess.displayName,
          role: 'supervisor',
        });
      } else {
        const passwordMatches = await user.comparePassword(config.devAccess.password);
        const needsSave = !passwordMatches
          || user.displayName !== config.devAccess.displayName
          || user.role !== 'supervisor';

        if (!passwordMatches) user.password = config.devAccess.password;
        user.displayName = config.devAccess.displayName;
        user.role = 'supervisor';
        if (needsSave) await user.save();
      }
    }

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await user.comparePassword(password);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = signToken(user);

    return res.json({
      token,
      user: user.toJSON(),
    });
  } catch (err) {
    console.error('[auth/login]', err.message);
    return res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * GET /me
 * Returns the current authenticated user.
 */
router.get('/me', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    return res.json({ user: user.toJSON() });
  } catch (err) {
    console.error('[auth/me]', err.message);
    return res.status(500).json({ error: 'Failed to fetch user' });
  }
});

/**
 * PUT /api-key
 * Save or clear the user's personal Anthropic API key.
 * Body: { apiKey: string | null }
 */
router.put('/api-key', authenticate, async (req, res) => {
  try {
    const { apiKey } = req.body;
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (apiKey && typeof apiKey === 'string' && apiKey.trim().length > 0) {
      // Basic format check
      if (!apiKey.startsWith('sk-ant-')) {
        return res.status(400).json({ error: 'Invalid Anthropic API key format (should start with sk-ant-)' });
      }
      user.anthropicApiKey = apiKey.trim();
    } else {
      user.anthropicApiKey = undefined;
    }

    await user.save();
    return res.json({ success: true, user: user.toJSON() });
  } catch (err) {
    console.error('[auth/api-key]', err.message);
    return res.status(500).json({ error: 'Failed to update API key' });
  }
});

module.exports = router;
