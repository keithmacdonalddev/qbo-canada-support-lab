const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: true,
    },
    displayName: {
      type: String,
    },
    role: {
      type: String,
      enum: ['agent', 'supervisor'],
      default: 'agent',
    },
    anthropicApiKey: {
      type: String,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        delete ret.password;
        // Mask API key — show only last 4 chars
        if (ret.anthropicApiKey) {
          ret.hasAnthropicKey = true;
          ret.anthropicApiKeyMasked = '••••' + ret.anthropicApiKey.slice(-4);
        } else {
          ret.hasAnthropicKey = false;
          ret.anthropicApiKeyMasked = null;
        }
        delete ret.anthropicApiKey;
        return ret;
      },
    },
  }
);

// Hash password before saving
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();

  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    return next();
  } catch (err) {
    return next(err);
  }
});

// Compare candidate password against stored hash
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
