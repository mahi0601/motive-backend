// const User = require('../models/user.model');
// const jwtUtil = require('../utils/jwt.util');

// exports.register = async (req, res) => {
//   const user = await User.create(req.body);
//   const token = jwtUtil.generateToken({ id: user._id });
//   res.json({ user, token });
// };

// exports.login = async (req, res) => {
//   const user = await User.findOne({ email: req.body.email });
//   if (!user) return res.status(404).json({ error: 'User not found' });

//   // You should use bcrypt to compare passwords in real apps
//   const token = jwtUtil.generateToken({ id: user._id });
//   res.json({ user, token });
// };
const User = require('../models/user.model');
const jwtUtil = require('../utils/jwt.util');

exports.register = async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // 1. Check for missing fields
    if (!name || !email || !password) {
      return res.status(400).json({ message: 'All fields are required' });
    }

    // 2. Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({ message: 'User already exists with this email' });
    }

    // 3. Create new user
    const user = await User.create({ name, email, password });

    // 4. Generate token
    const token = jwtUtil.generateToken({ id: user._id });

    return res.status(201).json({ user, token });

  } catch (error) {
    console.error('❌ Register Error:', error);

    // Handle duplicate key error (e.g., email already exists)
    if (error.code === 11000) {
      return res.status(409).json({ message: 'Email already exists (duplicate)' });
    }

    return res.status(500).json({ message: 'Internal Server Error' });
  }
};

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    // 1. Check fields
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    // 2. Check if user exists
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // 3. Check password (you should use bcrypt in production)
    if (user.password !== password) {
      return res.status(401).json({ message: 'Incorrect password' });
    }

    // 4. Generate token
    const token = jwtUtil.generateToken({ id: user._id });

    return res.status(200).json({ user, token });

  } catch (error) {
    console.error('❌ Login Error:', error);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
};
