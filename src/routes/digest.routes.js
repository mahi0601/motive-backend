const express = require('express');
const router = express.Router();
const { getDailyDigest } = require('../controllers/digest.controller');
const authMiddleware = require('../middlewares/auth.middleware');

router.get('/', authMiddleware, getDailyDigest);

module.exports = router;
