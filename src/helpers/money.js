const isMissing = (value) => value === undefined || value === null || value === ""

const parseMoney = (value) => {
  if (isMissing(value)) return null
  const normalized = String(value).replace(",", ".").trim()
  const parsed = Number(normalized)
  if (!Number.isFinite(parsed)) return null
  return Number(parsed.toFixed(2))
}

const isValidMoney = (value) => parseMoney(value) !== null

module.exports = {
  isMissing,
  isValidMoney,
  parseMoney,
}
