const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const SALT_ROUNDS = 12;

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    // select:false → the password hash is never returned by default queries.
    password: { type: String, required: true, select: false },
    avatar: { type: String, default: '' },
    // Bumped on logout / password change to invalidate all outstanding refresh tokens.
    tokenVersion: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Hash the password whenever it is set/changed — the single source of truth,
// so no controller can ever persist a plaintext password.
userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, SALT_ROUNDS);
  next();
});

// Constant-time comparison helper.
userSchema.methods.comparePassword = function comparePassword(candidate) {
  return bcrypt.compare(candidate, this.password);
};

// Defense in depth: never leak the hash even if it gets explicitly selected.
userSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.password;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('User', userSchema);
