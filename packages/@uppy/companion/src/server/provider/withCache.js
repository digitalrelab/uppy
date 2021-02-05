const cache = {}

const sizeKey = (providerName, id) => `${providerName}${id}size`

const addToCache = (key, data) => {
  cache[key] = data
}

const getFromCache = (key) => cache[key]

/**
 *
 * @param {*} provider
 */
module.exports.withCache = (provider) => {
  const providerName = provider.constructor.authProvider

  const wrapList = (list) => (options, cb) => {
    list(options, (err, data) => {
      if (err) {
        cb(err, data)
        return
      }

      for (const item of data.items) {
        if (!item.size || item.id == null) {
          continue
        }
        addToCache(sizeKey(providerName, item.id), item.size)
      }

      cb(err, data)
    })
  }

  const wrapSize = (size) => (options, cb) => {
    const key = sizeKey(providerName, options.id)
    const cached = getFromCache(key)
    if (cached) {
      cb(null, cached)
      return
    }

    size(options, (err, size) => {
      if (err) {
        cb(err, size)
        return
      }

      addToCache(key, size)

      cb(err, size)
    })
  }

  // modifying is ugly but whatever
  provider.list = wrapList(provider.list.bind(provider))
  provider.size = wrapSize(provider.size.bind(provider))

  return provider
}
