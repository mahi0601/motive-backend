const express = require('express');
const router = express.Router();
const FileController = require('../controllers/file.controller');
const auth = require('../middlewares/auth.middleware');

router.use(auth);
router.get('/task/:taskId', FileController.listByTask);
router.delete('/:id', FileController.remove);

module.exports = router;
