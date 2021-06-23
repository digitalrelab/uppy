const Provider = require('../Provider')

const request = require('request')
// @ts-ignore
const purest = require('purest')({ request })
const logger = require('../../logger')
const adapter = require('./adapter')
const { ProviderApiError, ProviderAuthError } = require('../error')
const { retryWithDelay } = require('../../helpers/utils')
const DRIVE_FILE_FIELDS = 'kind,id,name,mimeType,ownedByMe,permissions(role,emailAddress),size,modifiedTime,iconLink,thumbnailLink,teamDriveId'
const DRIVE_FILES_FIELDS = `kind,nextPageToken,incompleteSearch,files(${DRIVE_FILE_FIELDS})`
// using wildcard to get all 'drive' fields because specifying fields seems no to work for the /drives endpoint
const SHARED_DRIVE_FIELDS = '*'

const VIRTUAL_SHARED_DIR = 'shared-with-me'

/**
 * Adapter for API https://developers.google.com/drive/api/v3/
 */
class Drive extends Provider {
  constructor (options) {
    super(options)
    this.authProvider = options.provider = Drive.authProvider
    options.alias = 'drive'
    options.version = 'v3'

    this.client = purest(options)
  }

  static get authProvider () {
    return 'google'
  }

  list (options, done) {
    const directory = options.directory || 'root'
    const query = options.query || {}

    let sharedDrivesPromise = Promise.resolve(undefined)

    const isRoot = directory === 'root'
    const isVirtualSharedDirRoot = directory === VIRTUAL_SHARED_DIR

    const shouldListSharedDrives = directory === 'root' && !query.cursor
    if (shouldListSharedDrives) {
      sharedDrivesPromise = new Promise((resolve) => {
        this.client
          .query()
          .get('drives')
          .qs({ fields: SHARED_DRIVE_FIELDS })
          .auth(options.token)
          .request((err, resp) => {
            if (err) {
              logger.error(err, 'provider.drive.sharedDrive.error')
              return
            }
            resolve(resp)
          })
      })
    }

    const q = isVirtualSharedDirRoot
      ? 'sharedWithMe and trashed=false'
      : `('${directory}' in parents) and trashed=false`

    const where = {
      fields: DRIVE_FILES_FIELDS,
      pageToken: query.cursor,
      q,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true
    }

    const filesPromise = new Promise((resolve, reject) => {
      this.client
        .query()
        .get('files')
        .qs(where)
        .auth(options.token)
        .request((err, resp) => {
          if (err || resp.statusCode !== 200) {
            reject(this._error(err, resp))
            return
          }
          resolve(resp)
        })
    })

    Promise.all([sharedDrivesPromise, filesPromise])
      .then(
        ([sharedDrives, filesResponse]) => {
          const returnData = this.adaptData(
            filesResponse.body,
            sharedDrives && sharedDrives.body,
            directory,
            query,
            isRoot && !query.cursor
          )
          done(null, returnData)
        },
        (reqErr) => {
          logger.error(reqErr, 'provider.drive.list.error')
          done(reqErr)
        }
      )
  }

  stats ({ id, token }, done) {
    retryWithDelay({
      action: () => new Promise((resolve, reject) => {
        this.client
          .query()
          .get(`files/${id}`)
          .qs({ fields: DRIVE_FILE_FIELDS, supportsAllDrives: true })
          .auth(token)
          .request((err, resp, body) => {
            if (err) {
              reject(err)
            } else {
              resolve({ resp, body })
            }
          })
      }),
      retryDelays: [1000, 5000, 10000, 10000]
    })
      .then(
        ({ resp, body }) => done(null, resp, body),
        (err) => done(err)
      )
  }

  _exportGsuiteFile (id, token, mimeType) {
    logger.info(`calling google file export for ${id} to ${mimeType}`, 'provider.drive.export')
    return this.client
      .query()
      .get(`files/${id}/export`)
      .qs({ supportsAllDrives: true, mimeType })
      .auth(token)
      .request()
  }

  _waitForFailedResponse (resp) {
    return new Promise((resolve, reject) => {
      let data = ''
      resp.on('data', (chunk) => {
        data += chunk
      }).on('end', () => {
        try {
          resolve(JSON.parse(data.toString()))
        } catch (error) {
          reject(error)
        }
      })
    })
  }

  download ({ id, token }) {
    return new Promise((resolve, reject) => {
      this.stats({ id, token }, (err, _, body) => {
        if (err) {
          logger.error(err, 'provider.drive.download.stats.error')
          reject(err)
          return
        }

        let requestStream
        if (adapter.isGsuiteFile(body.mimeType)) {
          requestStream = this._exportGsuiteFile(id, token, adapter.getGsuiteExportType(body.mimeType))
        } else {
          requestStream = this.client
            .query()
            .get(`files/${id}`)
            .qs({ alt: 'media', supportsAllDrives: true })
            .auth(token)
            .request()
        }

        resolve(requestStream)
        // .on('error', (err) => {
        //   logger.error(err, 'provider.drive.download.error')
        //   reject(err)
        // })
        // .on('response', (resp) => {
        //   if (resp.statusCode !== 200) {
        //     this._waitForFailedResponse(resp)
        //       .then((jsonResp) => {
        //         resp.body = jsonResp
        //         reject(this._error(null, resp))
        //       })
        //       .catch((err) => reject(this._error(err, resp)))
        //   } else {
        //     resolve(resp)
        //   }
        // })
      })
    })
  }

  thumbnail (_, done) {
    // not implementing this because a public thumbnail from googledrive will be used instead
    const err = new Error('call to thumbnail is not implemented')
    logger.error(err, 'provider.drive.thumbnail.error')
    return done(err)
  }

  size ({ id, token }, done) {
    return this.stats({ id, token }, (err, resp, body) => {
      if (err || resp.statusCode !== 200) {
        err = this._error(err, resp)
        logger.error(err, 'provider.drive.size.error')
        return done(err)
      }

      if (adapter.isGsuiteFile(body.mimeType)) {
        // Not all GSuite file sizes can be predetermined
        // also for files whose size can be predetermined,
        // the request to get it can be sometimes expesnive, depending
        // on the file size. So we default the size to the size export limit
        const maxExportFileSize = 10 * 1024 * 1024 // 10 MB
        done(null, maxExportFileSize)
      } else {
        done(null, parseInt(body.size))
      }
    })
  }

  logout ({ token }, done) {
    return this.client
      .get('https://accounts.google.com/o/oauth2/revoke')
      .qs({ token })
      .request((err, resp) => {
        if (err || resp.statusCode !== 200) {
          logger.error(err, 'provider.drive.logout.error')
          done(this._error(err, resp))
          return
        }
        done(null, { revoked: true })
      })
  }

  adaptData (res, sharedDrivesResp, directory, query, showSharedWithMe) {
    const adaptItem = (item) => ({
      isFolder: adapter.isFolder(item),
      icon: adapter.getItemIcon(item),
      name: adapter.getItemName(item),
      mimeType: adapter.getMimeType(item),
      id: adapter.getItemId(item),
      thumbnail: adapter.getItemThumbnailUrl(item),
      requestPath: adapter.getItemRequestPath(item),
      modifiedDate: adapter.getItemModifiedDate(item),
      size: adapter.getItemSize(item),
      custom: {
        // @todo isTeamDrive is left for backward compatibility. We should remove it in the next
        // major release.
        isTeamDrive: adapter.isSharedDrive(item),
        isSharedDrive: adapter.isSharedDrive(item)
      }
    })

    const items = adapter.getItemSubList(res)
    const sharedDrives = sharedDrivesResp ? sharedDrivesResp.drives || [] : []

    // “Shared with me” is a list of shared documents,
    // not the same as sharedDrives
    const virtualItem = showSharedWithMe && ({
      isFolder: true,
      icon: 'folder',
      name: 'Shared with me',
      mimeType: 'application/vnd.google-apps.folder',
      id: VIRTUAL_SHARED_DIR,
      requestPath: VIRTUAL_SHARED_DIR
    })

    const adaptedItems = [
      ...(virtualItem ? [virtualItem] : []), // shared folder first
      ...([...sharedDrives, ...items].map(adaptItem))
    ]

    return {
      username: adapter.getUsername(res),
      items: adaptedItems,
      nextPagePath: adapter.getNextPagePath(res, query, directory)
    }
  }

  _error (err, resp) {
    if (resp) {
      const fallbackMessage = `request to ${this.authProvider} returned ${resp.statusCode}`
      const errMsg = (resp.body && resp.body.error) ? resp.body.error.message : fallbackMessage
      return resp.statusCode === 401 ? new ProviderAuthError() : new ProviderApiError(errMsg, resp.statusCode)
    }
    return err
  }
}

module.exports = Drive
