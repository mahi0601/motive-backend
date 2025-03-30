// const jwt = require('jsonwebtoken');

// exports.generateToken = (payload) => {
//   return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });
// };
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key'; // fallback if env is missing

// Generate JWT token
exports.generateToken = (payload, expiresIn = '7d') => {
  try {
    return jwt.sign(payload, JWT_SECRET, { expiresIn });
  } catch (error) {
    console.error('❌ Error generating JWT:', error.message);
    return null;
  }
};

// Optionally: Verify token helper (useful for auth middlewares)
exports.verifyToken = (token) => {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    console.error('❌ Invalid Token:', error.message);
    return null;
  }
};
