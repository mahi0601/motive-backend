const AppError = require('../utils/AppError');

// multer's memoryStorage holds each upload fully in memory until it is stored,
// and the API runs in a small (512 MB on the free plan) single instance. The
// per-ip rate limit bounds how often one client uploads, not how many uploads
// are in flight at once across everyone, so this caps the latter: beyond `max`
// concurrent uploads the request is refused with a 503 the client can retry.
exports.limitConcurrentUploads = (max = 5) => {
  let inFlight = 0;
  return (_req, res, next) => {
    if (inFlight >= max) return next(new AppError('The server is busy with other uploads — please try again in a moment.', 503));
    inFlight += 1;
    let released = false;
    const release = () => {
      if (released) return; // 'finish' and 'close' both fire for a normal response
      released = true;
      inFlight -= 1;
    };
    res.on('finish', release);
    res.on('close', release);
    next();
  };
};
