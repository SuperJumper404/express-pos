const isHttpStatus = (code) => Number.isInteger(code) && code >= 100 && code <= 599;

const send = (res, code, success, message, pagination = null, data = null, error = null) => {
  const response = {
    code,
    success,
    message,
    pagination,
    data,
  };

  if (error) {
    response.error = error;
  }

  return res.status(code).json(response);
};

module.exports = {
  custom: (res, code, message, pagination = null, data = null) => {
    const statusCode = isHttpStatus(code) ? code : 500;
    const responseMessage = isHttpStatus(code) ? message : code;
    const isSuccess = statusCode >= 200 && statusCode < 300;

    return send(res, statusCode, isSuccess, responseMessage, pagination, data);
  },
  success: (res, message, pagination = null, data = null) => {
    return send(res, 200, true, message, pagination, data);
  },
  failed: (res, message, statusTxt = null, code = 500) => {
    const statusCode = isHttpStatus(code) ? code : 500;

    return send(res, statusCode, false, message, null, null, statusTxt);
  },
};
