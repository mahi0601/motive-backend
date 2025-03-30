const express = require('express');
const router = express.Router();
const { getStatistics } = require('../controllers/statistics.controller');
const authMiddleware = require('../middlewares/auth.middleware');

router.get('/',authMiddleware, getStatistics);

module.exports = router;