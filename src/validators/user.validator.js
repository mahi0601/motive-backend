const { body } = require('express-validator');

// Which confirmation applies depends on the account (password vs. Google-only),
// which only the service knows — so the route just requires that one of the two
// was supplied; UserService#deleteAccount decides which one is actually valid.
exports.deleteAccountRules = [
  body().custom((value, { req }) => {
    const { password, confirmEmail } = req.body || {};
    if ((typeof password === 'string' && password) || (typeof confirmEmail === 'string' && confirmEmail.trim())) return true;
    throw new Error('Confirm with your password, or your account email if you signed in with Google');
  }),
  body('password').optional({ nullable: true }).isString().isLength({ max: 200 }),
  body('confirmEmail').optional({ nullable: true }).isString().isLength({ max: 320 }),
];

const isValidTimezone = (tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

exports.updateProfileRules = [
  body('name').optional().isString().trim().isLength({ min: 1, max: 80 }).withMessage('Name must be 1–80 characters'),
  body('avatar').optional({ nullable: true }).isString().isLength({ max: 2048 }),
  body('timezone').optional().isString().custom(isValidTimezone).withMessage('timezone must be a valid IANA time zone'),
  body('notifyClientResponsesByEmail').optional().isBoolean({ strict: true }).withMessage('notifyClientResponsesByEmail must be true or false'),
];

// A real boolean yes, not "true" or 1: this is the consent record.
exports.acceptTermsRules = [
  body('acceptTerms')
    .custom((v) => v === true)
    .withMessage('Please confirm you are 16 or older and agree to the Terms and Privacy Policy'),
];
