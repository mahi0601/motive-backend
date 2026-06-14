// src/controllers/user.controller.js
const UserService = require('../services/user.service');
const tokenService = require('../services/token.service');
const asyncHandler = require('../utils/asyncHandler');

exports.getUserProfile = asyncHandler(async (req, res) => {
  const user = await UserService.getProfile(req.user.id);
  res.status(200).json({ success: true, user });
});

exports.updateUserProfile = asyncHandler(async (req, res) => {
  const user = await UserService.updateProfile(req.user.id, req.body);
  res.status(200).json({ success: true, user });
});

// Permanently delete the account + all owned data. Requires the password again.
exports.deleteAccount = asyncHandler(async (req, res) => {
  await UserService.deleteAccount(req.user.id, req.body.password);
  tokenService.clearRefreshCookie(res); // the account (and its tokens) no longer exist
  res.status(200).json({ success: true, message: 'Account deleted' });
});
