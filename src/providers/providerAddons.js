// Add provider-specific registrar modules here. Each module returns a map of
// provider code to { create, getNetworks }; secrets stay in that adapter's
// validated configuration and never enter the registry metadata.
const addonRegistrars = Object.freeze([])

function loadProviderAddons(config, registrars = addonRegistrars) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || !Array.isArray(registrars)) {
    throw new TypeError('Provider add-on configuration is invalid')
  }
  const providers = {}
  for (const register of registrars) {
    if (typeof register !== 'function') throw new TypeError('Provider add-on registrar must be a function')
    const definitions = register(config)
    if (!definitions || typeof definitions !== 'object' || Array.isArray(definitions)) {
      throw new TypeError('Provider add-on registrar must return a provider definition map')
    }
    for (const [code, definition] of Object.entries(definitions)) {
      if (Object.hasOwn(providers, code)) throw new TypeError('Provider add-on codes must be unique')
      providers[code] = definition
    }
  }
  return Object.freeze(providers)
}

module.exports = { loadProviderAddons }
