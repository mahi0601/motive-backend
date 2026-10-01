// src/routes/upload.routes.js
const express = require('express');
const router = express.Router();
const UploadController = require('../controllers/upload.controller');
const upload = require('../middlewares/upload.middleware');
const auth = require('../middlewares/auth.middleware');
const { limitConcurrentUploads } = require('../middlewares/uploadConcurrency.middleware');

router.post('/', auth, limitConcurrentUploads(5), upload.single('file'), UploadController.uploadFile);

module.exports = router;
