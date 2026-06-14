// src/middlewares/validate.middleware.js
const { validationResult } = require('express-validator');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();

  const details = errors.array().map((e) => ({ field: e.path, message: e.msg }));
  return res.status(422).json({
    success: false,
    message: details[0].message, // first error, convenient for simple UIs
    errors: details,
  });
};

module.exports = validate;
