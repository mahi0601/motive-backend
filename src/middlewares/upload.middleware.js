// src/middlewares/upload.middleware.js
const multer = require('multer');
const path = require('path');
const AppError = require('../utils/AppError');

const fileFilter = (req, file, cb) => {
  const allowed = ['.png', '.jpg', '.jpeg', '.pdf', '.docx'];
  const ext = path.extname(file.originalname).toLowerCase();
  // An AppError here (rather than a bare Error) so it surfaces as the 400 it
  // actually is, instead of being masked as a generic 500 by the error handler.
  if (allowed.includes(ext)) cb(null, true);
  else cb(AppError.badRequest('Unsupported file format'), false);
};

// memoryStorage — storage.service.js decides where the buffer actually
// lands (Cloudflare R2 or local disk), so this middleware doesn't need to
// know or care which backend is active.
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 },
});

module.exports = upload;
