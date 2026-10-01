const router = require('express').Router();
const TaskController = require('../controllers/task.controller');
const auth = require('../middlewares/auth.middleware');
const validate = require('../middlewares/validate.middleware');
const { createTaskRules, updateTaskRules } = require('../validators/task.validator');

router.use(auth);
router.get('/search', TaskController.search);
router.get('/', TaskController.getTasks);
router.post('/', createTaskRules, validate, TaskController.createTask);
router.patch('/:id', updateTaskRules, validate, TaskController.updateTask);
router.delete('/:id', TaskController.deleteTask);

module.exports = router;
