// Carries the client ip of the current request to code that has no `req`
// (services writing audit events), without threading it through every call.
const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

exports.middleware = (req, _res, next) => storage.run({ ip: req.ip || req.socket?.remoteAddress }, next);
exports.currentIp = () => storage.getStore()?.ip;
