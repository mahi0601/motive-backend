// src/controllers/user.controller.js
const User = require('../models/user.model');

exports.getUserProfile = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    res.status(200).json({ success: true, user });
  } catch (err) {
    next(err);
  }
};

exports.updateUserProfile = async (req, res, next) => {
  try {
    const updated = await User.findByIdAndUpdate(req.user.id, req.body, { new: true });
    res.status(200).json({ success: true, updated });
  } catch (err) {
    next(err);
  }
};
