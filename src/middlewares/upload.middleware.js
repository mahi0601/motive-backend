// src/middlewares/upload.middleware.js
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// public/uploads/ is gitignored (uploaded content shouldn't be committed), so
// it doesn't exist on a fresh clone/deploy — multer's diskStorage needs the
// destination to already exist, it won't create it.
const UPLOAD_DIR = 'public/uploads/';
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// File storage config
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueName + path.extname(file.originalname));
  }
});

const fileFilter = (req, file, cb) => {
  const allowed = ['.png', '.jpg', '.jpeg', '.pdf', '.docx'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowed.includes(ext)) cb(null, true);
  else cb(new Error('Unsupported file format'), false);
};

const upload = multer({ storage, fileFilter });

module.exports = upload;
