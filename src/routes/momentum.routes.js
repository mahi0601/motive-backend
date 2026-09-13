const express = require('express');
const router = express.Router();
const { getMomentum } = require('../controllers/momentum.controller');
const authMiddleware = require('../middlewares/auth.middleware');

router.get('/', authMiddleware, getMomentum);

module.exports = router;
