const Provider = require('../Provider')

const request = require('request')
const purest = require('purest')({ request })
const { getURLMeta } = require('../../helpers/request')
const logger = require('../../logger')
const adapter = require('./adapter')
const { ProviderApiError, ProviderAuthError } = require('../error')
const { TemporaryCache } = require('../../helpers/utils')

const cache = new TemporaryCache()

/**
 * Adapter for API https://developers.facebook.com/docs/graph-api/using-graph-api/
 */
class Facebook extends Provider {
  constructor (options) {
    super(options)
    this.authProvider = options.provider = Facebook.authProvider
    this.client = purest(options)
  }

  static get authProvider () {
    return 'facebook'
  }

  list ({ directory, token, query = { cursor: null } }, done) {
    const qs = {
      fields: 'name,cover_photo,created_time,type'
    }

    if (query.cursor) {
      qs.after = query.cursor
    }

    let path = 'me/albums'
    if (directory) {
      path = `${directory}/photos`
      qs.fields = 'icon,images,name,width,height,created_time'
    }

    this.client
      .get(`https://graph.facebook.com/${path}`)
      .qs(qs)
      .auth(token)
      .request((err, resp, body) => {
        if (err || resp.statusCode !== 200) {
          err = this._error(err, resp)
          logger.error(err, 'provider.facebook.list.error')
          return done(err)
        } else {
          this._getUsername(token, (err, username) => {
            if (err) {
              return done(err)
            }

            const items = adapter.getItemSubList(body)

            Promise.all(items.map((item) => {
              if (!item.images || !item.images.length) {
                return
              }
              const urlKey = `${token}:${adapter.getItemId(item)}:mediaUrl`
              cache.add(urlKey, this._getMediaUrl(item.images), 5 * 60 * 10000)
              return new Promise((resolve, reject) => {
                if (!item.images || !item.images.length) {
                  return resolve()
                }
                this.size({ id: item.id, token }, (err, size) => {
                  if (err) {
                    return reject(err)
                  }

                  item.size = size
                  resolve()
                })
              })
            }))
              .then(() => {
                done(null, this.adaptData(body, username, directory, query))
              })
          })
        }
      })
  }

  _getUsername (token, done) {
    const key = `${token}:username`
    const cached = cache.get(key)
    if (cached) {
      console.log('facebook.username.cached')
      return done(null, cached)
    }

    this.client
      .get('me')
      .qs({ fields: 'email' })
      .auth(token)
      .request((err, resp, body) => {
        if (err || resp.statusCode !== 200) {
          err = this._error(err, resp)
          logger.error(err, 'provider.facebook.user.error')
          return done(err)
        } else {
          cache.add(key, body.email, 5 * 60 * 1000)
          done(null, body.email)
        }
      })
  }

  _getMediaUrl (images) {
    const sortedImages = adapter.sortImages(images)
    return sortedImages[sortedImages.length - 1].source
  }

  download ({ id, token }) {
    return new Promise((resolve, reject) => {
      const key = `${token}:${id}:mediaUrl`
      const cached = cache.get(key)
      if (cached) {
        resolve(request(cached))
        return
      }

      this.client
        .get(`https://graph.facebook.com/${id}`)
        .qs({ fields: 'images' })
        .auth(token)
        .request((err, resp, body) => {
          if (err || resp.statusCode !== 200) {
            err = this._error(err, resp)
            logger.error(err, 'provider.facebook.download.error')
            reject(err)
            return
          }

          const url = this._getMediaUrl(body.images)
          cache.add(key, url, 5 * 60 * 1000)
          resolve(request(url))
        })
    })
  }

  thumbnail (_, done) {
    // not implementing this because a public thumbnail from facebook will be used instead
    const err = new Error('call to thumbnail is not implemented')
    logger.error(err, 'provider.facebook.thumbnail.error')
    return done(err)
  }

  size ({ id, token }, done) {
    const sizeKey = `${token}:${id}:size`
    const cachedSize = cache.get(sizeKey)
    if (cachedSize) {
      return done(null, cachedSize)
    }

    const getSize = (url) => getURLMeta(url)
      .then(({ size }) => done(null, size))
      .catch((err) => {
        logger.error(err, 'provider.facebook.size.error')
        done()
      })

    const urlKey = `${token}:${id}:mediaUrl`
    const cachedUrl = cache.get(urlKey)
    if (cachedUrl) {
      return getSize(cachedUrl)
    }

    return this.client
      .get(`https://graph.facebook.com/${id}`)
      .qs({ fields: 'images' })
      .auth(token)
      .request((err, resp, body) => {
        if (err || resp.statusCode !== 200) {
          err = this._error(err, resp)
          logger.error(err, 'provider.facebook.size.error')
          return done(err)
        }

        return getSize(this._getMediaUrl(body.images))
      })
  }

  logout ({ token }, done) {
    return this.client
      .delete('me/permissions')
      .auth(token)
      .request((err, resp) => {
        if (err || resp.statusCode !== 200) {
          logger.error(err, 'provider.facebook.logout.error')
          done(this._error(err, resp))
          return
        }
        done(null, { revoked: true })
      })
  }

  adaptData (res, username, directory, currentQuery) {
    const data = { username: username, items: [] }
    const items = adapter.getItemSubList(res)
    items.forEach((item) => {
      data.items.push({
        isFolder: adapter.isFolder(item),
        icon: adapter.getItemIcon(item),
        name: adapter.getItemName(item),
        mimeType: adapter.getMimeType(item),
        size: adapter.getItemSize(item),
        id: adapter.getItemId(item),
        thumbnail: adapter.getItemThumbnailUrl(item),
        requestPath: adapter.getItemRequestPath(item),
        modifiedDate: adapter.getItemModifiedDate(item)
      })
    })

    data.nextPagePath = adapter.getNextPagePath(res, currentQuery, directory)
    return data
  }

  _error (err, resp) {
    if (resp) {
      if (resp.body && resp.body.error.code === 190) {
        // Invalid OAuth 2.0 Access Token
        return new ProviderAuthError()
      }

      const fallbackMessage = `request to ${this.authProvider} returned ${resp.statusCode}`
      const msg = resp.body && resp.body.error ? resp.body.error.message : fallbackMessage
      return new ProviderApiError(msg, resp.statusCode)
    }

    return err
  }
}

module.exports = Facebook
