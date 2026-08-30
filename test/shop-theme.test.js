const assert = require('assert')
const {
  DEFAULT_SHOP_THEME,
  SHOP_THEME_PRESETS,
  normalizeShopTheme,
} = require('../src/helpers/shopTheme')

assert.strictEqual(DEFAULT_SHOP_THEME.preset, 'default')
assert.strictEqual(DEFAULT_SHOP_THEME.colors.primary, '#1976d2')
assert.strictEqual(DEFAULT_SHOP_THEME.colors.borderSoft, '#e8edf3')
assert.ok(SHOP_THEME_PRESETS.default)

assert.deepStrictEqual(normalizeShopTheme(null), DEFAULT_SHOP_THEME)
assert.deepStrictEqual(normalizeShopTheme(''), DEFAULT_SHOP_THEME)
assert.deepStrictEqual(normalizeShopTheme('{bad json'), DEFAULT_SHOP_THEME)

assert.deepStrictEqual(
  normalizeShopTheme({
    preset: 'unknown',
    colors: {
      primary: '#abc',
      background: 'red',
      custom: '#000000',
    },
    extra: true,
  }),
  {
    preset: 'default',
    colors: {
      ...DEFAULT_SHOP_THEME.colors,
      primary: '#abc',
    },
  }
)

assert.deepStrictEqual(
  normalizeShopTheme(
    JSON.stringify({
      preset: 'default',
      colors: {
        primary: '#123456',
        primaryHover: '#234567',
        danger: '#345678',
      },
    })
  ),
  {
    preset: 'default',
    colors: {
      ...DEFAULT_SHOP_THEME.colors,
      primary: '#123456',
      primaryHover: '#234567',
      danger: '#345678',
    },
  }
)

console.log('shop theme tests passed')
