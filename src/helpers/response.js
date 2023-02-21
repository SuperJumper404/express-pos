module.exports = {
  custom: (res, code, message, pagination, data) => {
    const response = {
      code,
      message,
      pagination,
      data
    }
    res.json(response)
  },
  success: (res, message, pagination, data) => {
    const response = {
      code: 200,
      message,
      pagination,
      data
    }
    res.json(response)
  },
  failed: (res, message, statusTxt) => {
    const response = {
      code: 500,
      message,
      statusTxt
    }
    res.json(response)
  }
}