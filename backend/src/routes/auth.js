const express = require('express');
const { assertPrivatePassword } = require('../modules/account-recovery');
const { issueToken } = require('../modules/auth-token');
const { RESERVED_EMAIL, normalizeEmail, publicTesterAttempt, accountEligible } = require('../modules/account-policy');
const DefaultUser = require('../models/User');
const { authenticate } = require('../middleware/auth');

function createAuthRouter({ Users: User = DefaultUser, automation = () => require('../modules/account-automation-review').accountAutomationReview() } = {}) {
const router = express.Router();

/**
 * Helper -- sign a JWT for the given user document.
 */
function signToken(user) { return issueToken(user); }

// No passwords are published and no development login can create, promote or
// reset a real-company account. Reserved legacy access needs explicit recovery.
router.get('/dev-access', (_req,res) => res.json({ enabled: false }));

/**
 * POST /register
 * Body: { email, password, displayName, role? }
 */
router.post('/register', async (req, res) => {
  try {
    const { password, displayName } = req.body;
    const email = normalizeEmail(req.body.email);

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    if (normalizeEmail(email) === RESERVED_EMAIL) {
      return res.status(409).json({ error: 'This account name is reserved for explicit local credential recovery.' });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ error: 'Enter a valid email address.' });
    try { assertPrivatePassword(password); } catch (error) { return res.status(400).json({ error:error.message }); }
    const existing = await User.findOne({ email });
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

    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password || email.length > 254 || Buffer.byteLength(password,'utf8') > 72) {
      return res.status(400).json({ error: 'Email and password are required within the supported length.' });
    }

    const normalizedEmail = normalizeEmail(email);
    if (publicTesterAttempt(email,password)) return res.status(401).json({ error: 'Invalid credentials' });
    const user = await User.findOne({ email: normalizedEmail }).select('+password');
    if (!user || !accountEligible(user)) return res.status(401).json({ error: 'Invalid credentials or account recovery required' });

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

router.get('/automation-review', authenticate, async (req,res) => {
  try { return res.json(await automation().review(req.user.id)); }
  catch(error) { return res.status(error.status||503).json({error:error.status?error.message:'Retained work could not be read. Automation remains paused.'}); }
});
router.post('/automation-enable', authenticate, async (req,res) => {
  try { return res.json(await automation().enable(req.user.id,req.body)); }
  catch(error) { return res.status(error.status||503).json({error:error.status?error.message:'Automation could not be enabled. Read the current review before retrying.'}); }
});
return router;
}
module.exports = createAuthRouter();
module.exports.createAuthRouter = createAuthRouter;
