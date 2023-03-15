module.exports = {
  custom: (res, code, message, data) => {
    const response = { code, message, data };
    res.json(response);
  },
  success: (res, message, data) => {
    const response = { code: 200, message, data };
    res.json(response);
  },
  failed: (res, message, statusTxt) => {
    const response = { code: 500, message, statusTxt };
    res.json(response);
  },
};
