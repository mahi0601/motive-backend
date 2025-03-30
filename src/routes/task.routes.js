const router = require('express').Router();
const TaskController = require('../controllers/task.controller');
const auth = require('../middlewares/auth.middleware');

router.use(auth);
router.get('/', TaskController.getTasks);
router.post('/', TaskController.createTask);

module.exports = router;
