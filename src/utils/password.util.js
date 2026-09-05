const bcrypt = require('bcryptjs');

const SALT_ROUNDS = 12;

// Was a Mongoose `pre('save')` hook — now called explicitly wherever a
// password is set, since Prisma has no schema-level hooks.
exports.hashPassword = (plain) => bcrypt.hash(plain, SALT_ROUNDS);

exports.comparePassword = (candidate, hash) => bcrypt.compare(candidate, hash);
