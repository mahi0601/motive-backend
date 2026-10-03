const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const TaskController = require('../controllers/task.controller');
const auth = require('../middlewares/auth.middleware');
const validate = require('../middlewares/validate.middleware');
const { createTaskRules, updateTaskRules, importTasksRules } = require('../validators/task.validator');

router.use(auth);
router.get('/search', TaskController.search);
router.get('/', TaskController.getTasks);
router.post('/', createTaskRules, validate, TaskController.createTask);
// One import can create up to 500 tasks, so it is capped well below the global limit.
// IMPORT_RATE_MAX can raise it (tests); only a positive number counts.
const importMax = Number.parseInt(process.env.IMPORT_RATE_MAX, 10);
const importLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: importMax > 0 ? importMax : 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many imports, try again later.' },
});
router.post('/import', importLimiter, importTasksRules, validate, TaskController.importTasks);
router.patch('/:id', updateTaskRules, validate, TaskController.updateTask);
router.delete('/:id', TaskController.deleteTask);

module.exports = router;
