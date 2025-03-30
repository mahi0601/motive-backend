// src/utils/response.js
exports.success = (res, message = 'Success', data = {}, status = 200) => {
    return res.status(status).json({ success: true, message, data });
  };
  
  exports.error = (res, message = 'Something went wrong', status = 500) => {
    return res.status(status).json({ success: false, message });
  };
  