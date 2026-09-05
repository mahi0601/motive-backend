const express = require('express');
const router = express.Router();
const { getActivity } = require('../controllers/activity.controller');
const authMiddleware = require('../middlewares/auth.middleware');

router.get('/', authMiddleware, getActivity);

module.exports = router;
