// src/routes/upload.routes.js
const express = require('express');
const router = express.Router();
const UploadController = require('../controllers/upload.controller');
const upload = require('../middlewares/upload.middleware');
const auth = require('../middlewares/auth.middleware');

router.post('/', auth, upload.single('file'), UploadController.uploadFile);

module.exports = router;
