const DEFAULT_SHOP_THEME = {
  preset: 'default',
  colors: {
    primary: '#1976d2',
    primaryHover: '#155fa8',
    primarySoft: '#e8f2ff',
    background: '#f3f5f8',
    surface: '#ffffff',
    surfaceMuted: '#f8fafc',
    border: '#dfe5ee',
    borderSoft: '#e8edf3',
    text: '#121826',
    textBody: '#1f2933',
    textMuted: '#687386',
    success: '#00e676',
    warning: '#ffa014',
    danger: '#d83b3b',
  },
}

const SHOP_THEME_PRESETS = {
  default: DEFAULT_SHOP_THEME,
}

const COLOR_KEYS = Object.keys(DEFAULT_SHOP_THEME.colors)
const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

const cloneDefaultTheme = () => ({
  preset: DEFAULT_SHOP_THEME.preset,
  colors: { ...DEFAULT_SHOP_THEME.colors },
})

const parseThemeValue = (value) => {
  if (!value) return null
  if (typeof value === 'object') return value
  if (typeof value !== 'string') return null

  try {
    return JSON.parse(value)
  } catch (error) {
    return null
  }
}

const normalizeShopTheme = (value) => {
  const parsed = parseThemeValue(value)
  if (!parsed || typeof parsed !== 'object') return cloneDefaultTheme()

  const preset = Object.prototype.hasOwnProperty.call(
    SHOP_THEME_PRESETS,
    parsed.preset
  )
    ? parsed.preset
    : DEFAULT_SHOP_THEME.preset

  const normalized = {
    preset,
    colors: { ...DEFAULT_SHOP_THEME.colors },
  }

  const colors =
    parsed.colors && typeof parsed.colors === 'object' ? parsed.colors : {}

  COLOR_KEYS.forEach((key) => {
    if (HEX_COLOR_PATTERN.test(colors[key])) {
      normalized.colors[key] = colors[key]
    }
  })

  return normalized
}

module.exports = {
  DEFAULT_SHOP_THEME,
  SHOP_THEME_PRESETS,
  normalizeShopTheme,
}
