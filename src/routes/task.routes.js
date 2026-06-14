const router = require('express').Router();
const TaskController = require('../controllers/task.controller');
const auth = require('../middlewares/auth.middleware');

router.use(auth);
router.get('/', TaskController.getTasks);
router.post('/', TaskController.createTask);
router.patch('/:id', TaskController.updateTask);
router.delete('/:id', TaskController.deleteTask);

module.exports = router;
