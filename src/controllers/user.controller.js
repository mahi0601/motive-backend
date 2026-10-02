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

// A one-off JSON download of the user's own data. Not cacheable, and sent as an
// attachment so the browser saves it instead of rendering it.
exports.exportData = asyncHandler(async (req, res) => {
  const data = await UserService.exportData(req.user.id);
  res.set('Cache-Control', 'no-store');
  res.set('Content-Disposition', `attachment; filename="clientglass-export-${new Date().toISOString().slice(0, 10)}.json"`);
  res.status(200).json(data);
});

// Permanently delete the account + all owned data. Requires the password again
// (or, for a Google-only account, its email typed out).
exports.deleteAccount = asyncHandler(async (req, res) => {
  await UserService.deleteAccount(req.user.id, req.body.password, req.body.confirmEmail);
  tokenService.clearRefreshCookie(res); // the account (and its tokens) no longer exist
  res.status(200).json({ success: true, message: 'Account deleted' });
});
