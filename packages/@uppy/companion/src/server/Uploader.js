const tus = require('tus-js-client')
const uuid = require('uuid')
const isObject = require('isobject')
const validator = require('validator')
const request = require('request')
const emitter = require('./emitter')
const serializeError = require('serialize-error')
const { jsonStringify, hasMatch } = require('./helpers/utils')
const logger = require('./logger')
const headerSanitize = require('./header-blacklist')
const redis = require('./redis')
const UppyHttpStack = require('./httpStack')

const DEFAULT_FIELD_NAME = 'files[]'
const PROTOCOLS = Object.freeze({
  multipart: 'multipart',
  s3Multipart: 's3-multipart',
  tus: 'tus'
})

class Uploader {
  /**
   * Uploads file to destination based on the supplied protocol (tus, s3-multipart, multipart)
   * For tus uploads, the deferredLength option is enabled, because file size value can be unreliable
   * for some providers (Instagram particularly)
   *
   * @typedef {object} UploaderOptions
   * @property {string} endpoint
   * @property {string=} uploadUrl
   * @property {string} protocol
   * @property {number} size
   * @property {string=} fieldname
   * @property {string} pathPrefix
   * @property {any=} s3
   * @property {any} metadata
   * @property {any} companionOptions
   * @property {any=} storage
   * @property {any=} headers
   * @property {string=} httpMethod
   * @property {boolean=} useFormData
   * @property {string=} token
   *
   * @param {UploaderOptions} options
   */
  constructor (options) {
    if (!this.validateOptions(options)) {
      logger.debug(this._errRespMessage, 'uploader.validator.fail')
      return
    }

    this.options = options
    this.token = this.options.token || uuid.v4()
    this.options.metadata = this.options.metadata || {}
    this.options.fieldname = this.options.fieldname || DEFAULT_FIELD_NAME
    this.uploadFileName = this.options.metadata.name || `${Uploader.FILE_NAME_PREFIX}-${this.token}`
    this.uploadStopped = false
    this.multipartStarted = false

    /** @type {number} */
    this.emittedProgress = 0
    this.storage = options.storage
    this._paused = false

    this._pushToStream = false
    this._buffers = []
    this._downloadComplete = false

    if (this.options.protocol === PROTOCOLS.tus) {
      emitter().on(`pause:${this.token}`, () => {
        this._paused = true
        if (this.tus) {
          this.tus.abort()
        }
      })

      emitter().on(`resume:${this.token}`, () => {
        this._paused = false
        if (this.tus) {
          this.tus.start()
        }
      })

      emitter().on(`cancel:${this.token}`, () => {
        this.cancel()
      })
    }
  }

  /**
   * returns a substring of the token. Used as traceId for logging
   * we avoid using the entire token because this is meant to be a short term
   * access token between uppy client and companion websocket
   * @param {string} token the token to Shorten
   * @returns {string}
   */
  static shortenToken (token) {
    return token.substring(0, 8)
  }

  static reqToOptions (req, size) {
    const useFormDataIsSet = Object.prototype.hasOwnProperty.call(req.body, 'useFormData')
    const useFormData = useFormDataIsSet ? req.body.useFormData : true

    return {
      companionOptions: req.companion.options,
      endpoint: req.body.endpoint,
      uploadUrl: req.body.uploadUrl,
      protocol: req.body.protocol,
      metadata: req.body.metadata,
      httpMethod: req.body.httpMethod,
      useFormData,
      size,
      fieldname: req.body.fieldname,
      pathPrefix: `${req.companion.options.filePath}`,
      storage: redis.client(),
      s3: req.companion.s3Client ? {
        client: req.companion.s3Client,
        options: req.companion.options.providerOptions.s3
      } : null,
      headers: req.body.headers
    }
  }

  /**
   * Validate the options passed down to the uplaoder
   *
   * @param {UploaderOptions} options
   * @returns {boolean}
   */
  validateOptions (options) {
    // validate HTTP Method
    if (options.httpMethod) {
      if (typeof options.httpMethod !== 'string') {
        this._errRespMessage = 'unsupported HTTP METHOD specified'
        return false
      }

      const method = options.httpMethod.toLowerCase()
      if (method !== 'put' && method !== 'post') {
        this._errRespMessage = 'unsupported HTTP METHOD specified'
        return false
      }
    }

    // validate fieldname
    if (options.fieldname && typeof options.fieldname !== 'string') {
      this._errRespMessage = 'fieldname must be a string'
      return false
    }

    // validate metadata
    if (options.metadata && !isObject(options.metadata)) {
      this._errRespMessage = 'metadata must be an object'
      return false
    }

    // validate headers
    if (options.headers && !isObject(options.headers)) {
      this._errRespMessage = 'headers must be an object'
      return false
    }

    // validate protocol
    // @todo this validation should not be conditional once the protocol field is mandatory
    if (options.protocol && !Object.keys(PROTOCOLS).some((key) => PROTOCOLS[key] === options.protocol)) {
      this._errRespMessage = 'unsupported protocol specified'
      return false
    }

    // s3 uploads don't require upload destination
    // validation, because the destination is determined
    // by the server's s3 config
    if (options.protocol === PROTOCOLS.s3Multipart) {
      return true
    }

    if (!options.endpoint && !options.uploadUrl) {
      this._errRespMessage = 'no destination specified'
      return false
    }

    const validatorOpts = { require_protocol: true, require_tld: !options.companionOptions.debug }
    return [options.endpoint, options.uploadUrl].every((url) => {
      if (url && !validator.isURL(url, validatorOpts)) {
        this._errRespMessage = 'invalid destination url'
        return false
      }

      const allowedUrls = options.companionOptions.uploadUrls
      if (allowedUrls && url && !hasMatch(url, allowedUrls)) {
        this._errRespMessage = 'upload destination does not match any allowed destinations'
        return false
      }

      return true
    })
  }

  hasError () {
    return this._errRespMessage != null
  }

  /**
   * returns a substring of the token. Used as traceId for logging
   * we avoid using the entire token because this is meant to be a short term
   * access token between uppy client and companion websocket
   */
  get shortToken () {
    return Uploader.shortenToken(this.token)
  }

  /**
   *
   * @param {function} callback
   */
  onSocketReady (callback) {
    emitter().once(`connection:${this.token}`, () => callback())
    logger.debug('waiting for connection', 'uploader.socket.wait', this.shortToken)
  }

  cancel () {
    this._paused = true
    if (this.tus) {
      const shouldTerminate = !!this.tus.url
      const abortPromise = this.tus.abort(shouldTerminate)
      if (abortPromise) {
        abortPromise.catch(() => {})
      }
    }
    this.cleanUp()
  }

  cleanUp () {
    if (this.uploadStopped) {
      return
    }

    emitter().removeAllListeners(`pause:${this.token}`)
    emitter().removeAllListeners(`resume:${this.token}`)
    emitter().removeAllListeners(`cancel:${this.token}`)
    this.uploadStopped = true
  }

  upload (stream) {
    if (this.uploadStopped) {
      logger.warn('Upload called on canceled uploader', 'uploader.upload')
      return
    }

    stream.on('error', (err) => {
      logger.error(err, 'uploader.download.error', this.shortToken)
      this.emitRetry(err)
      this.cleanUp()
    })

    const protocol = this.options.protocol || PROTOCOLS.multipart
    switch (protocol) {
      case PROTOCOLS.multipart:
        if (!this.multipartStarted && this.options.endpoint) {
          this.uploadMultipart(stream)
        } else {
          logger.warn('Upload called twice', 'uploader.download.multipart')
        }
        break
      case PROTOCOLS.s3Multipart:
        if (!this.s3Upload) {
          this.uploadS3Multipart(stream)
        } else {
          logger.warn('Upload called twice', 'uploader.download.s3')
        }
        break
      case PROTOCOLS.tus:
        if (!this.tus) {
          this.uploadTus(stream)
        } else {
          logger.warn('Upload called twice', 'uploader.download.tus')
        }
        break
    }
  }

  getResponse () {
    if (this._errRespMessage) {
      return { body: { message: this._errRespMessage }, status: 400 }
    }
    return { body: { token: this.token }, status: 200 }
  }

  /**
   * @typedef {{action: string, payload: object}} State
   * @param {State} state
   */
  saveState (state) {
    if (!this.storage) return
    this.storage.set(`${Uploader.STORAGE_PREFIX}:${this.token}`, jsonStringify(state))
  }

  /**
   *
   * @param {number} bytesUploaded
   * @param {number | null} bytesTotal
   */
  emitProgress (bytesUploaded, bytesTotal) {
    bytesTotal = bytesTotal || this.options.size
    // if (this.tus && this.tus.options.uploadLengthDeferred) {
    // bytesTotal = this.bytesWritten
    // }
    const percentage = (bytesUploaded / bytesTotal * 100)
    const formatPercentage = percentage.toFixed(2)
    logger.debug(
      `${bytesUploaded} ${bytesTotal} ${formatPercentage}%`,
      'uploader.upload.progress',
      this.shortToken
    )

    const dataToEmit = {
      action: 'progress',
      payload: { progress: formatPercentage, bytesUploaded, bytesTotal }
    }
    this.saveState(dataToEmit)

    // avoid flooding the client with progress events.
    const roundedPercentage = Math.floor(percentage)
    if (this.emittedProgress !== roundedPercentage) {
      this.emittedProgress = roundedPercentage
      emitter().emit(this.token, dataToEmit)
    }
  }

  /**
   *
   * @param {string} url
   * @param {object} extraData
   */
  emitSuccess (url, extraData = {}) {
    const emitData = {
      action: 'success',
      payload: Object.assign(extraData, { complete: true, url })
    }
    this.saveState(emitData)
    emitter().emit(this.token, emitData)
  }

  /**
   *
   * @param {Error} err
   * @param {object=} extraData
   */
  emitError (err, extraData = {}) {
    const serializedErr = serializeError(err)
    // delete stack to avoid sending server info to client
    delete serializedErr.stack
    const dataToEmit = {
      action: 'error',
      payload: Object.assign(extraData, { error: serializedErr })
    }
    this.saveState(dataToEmit)
    emitter().emit(this.token, dataToEmit)
  }

  /**
   * Added this to filter errors out in get.js
   * @param {Error} err
   * @param {object=} extraData
   */
  emitRetry (err, extraData = {}) {
    const serializedErr = serializeError(err)
    // delete stack to avoid sending server info to client
    delete serializedErr.stack
    const dataToEmit = {
      action: 'retry',
      payload: Object.assign(extraData, { error: serializedErr })
    }
    this.saveState(dataToEmit)
    emitter().emit(this.token, dataToEmit)
  }

  emitQueued () {
    emitter().emit(this.token, {
      action: 'queued',
      payload: {}
    })
  }

  /**
   * start the tus upload
   */
  uploadTus (stream) {
    this.tus = new tus.Upload(stream, {
      endpoint: this.options.endpoint,
      uploadUrl: this.options.uploadUrl,
      uploadLengthDeferred: false,
      // retryDelays: null,
      uploadSize: this.options.size,
      chunkSize: 25 * 1024 * 1024,
      headers: headerSanitize(this.options.headers),
      addRequestId: true,
      httpStack: new UppyHttpStack(),
      metadata: Object.assign(
        {
          // file name and type as required by the tusd tus server
          // https://github.com/tus/tusd/blob/5b376141903c1fd64480c06dde3dfe61d191e53d/unrouted_handler.go#L614-L646
          filename: this.uploadFileName,
          filetype: this.options.metadata.type
        }, this.options.metadata
      ),
      /**
       *
       * @param {Error} error
       */
      onError: (error) => {
        logger.error(error, 'uploader.tus.error')
        // deleting tus originalRequest field because it uses the same http-agent
        // as companion, and this agent may contain sensitive request details (e.g headers)
        // previously made to providers. Deleting the field would prevent it from getting leaked
        // to the frontend etc.
        // @ts-ignore
        delete error.originalRequest
        // @ts-ignore
        delete error.originalResponse
        stream.destroy()
        this.emitRetry(error)
        this.cleanUp()
      },
      /**
       *
       * @param {number} bytesUploaded
       * @param {number} bytesTotal
       */
      onProgress: (bytesUploaded, bytesTotal) => {
        this.emitProgress(bytesUploaded, bytesTotal)
      },
      onSuccess: () => {
        this.emitSuccess(this.tus.url)
        this.cleanUp()
      }
    })

    if (!this._paused) {
      this.tus.start()
    }
  }

  uploadMultipart (stream) {
    this.multipartStarted = true

    // upload progress
    let bytesUploaded = 0
    stream.on('data', (data) => {
      bytesUploaded += data.length
      this.emitProgress(bytesUploaded, this.options.size)
    })

    const httpMethod = (this.options.httpMethod || '').toLowerCase() === 'put' ? 'put' : 'post'
    const headers = headerSanitize(this.options.headers)
    const reqOptions = { url: this.options.endpoint, headers, encoding: null }
    const httpRequest = request[httpMethod]
    if (this.options.useFormData) {
      reqOptions.formData = Object.assign(
        {},
        this.options.metadata,
        {
          [this.options.fieldname]: {
            value: stream,
            options: {
              filename: this.uploadFileName,
              contentType: this.options.metadata.type
            }
          }
        }
      )

      httpRequest(reqOptions, (error, response, body) => {
        this._onMultipartComplete(error, response, body, this.options.size)
      })
    } else {
      reqOptions.headers['content-length'] = this.options.size
      reqOptions.body = stream
      httpRequest(reqOptions, (error, response, body) => {
        this._onMultipartComplete(error, response, body, bytesUploaded)
      })
    }
  }

  _onMultipartComplete (error, response, body, bytesUploaded) {
    if (error) {
      logger.error(error, 'upload.multipart.error')
      this.emitRetry(error)
      return
    }
    const headers = response.headers
    // remove browser forbidden headers
    delete headers['set-cookie']
    delete headers['set-cookie2']

    const respObj = {
      responseText: body.toString(),
      status: response.statusCode,
      statusText: response.statusMessage,
      headers
    }

    if (response.statusCode >= 400) {
      logger.error(`upload failed with status: ${response.statusCode}`, 'upload.multipart.error')
      this.emitRetry(new Error(response.statusMessage), respObj)
    } else if (bytesUploaded !== this.options.size) {
      const errMsg = `uploaded only ${bytesUploaded} of ${this.options.size} with status: ${response.statusCode}`
      logger.error(errMsg, 'upload.multipart.mismatch.error')
      this.emitRetry(new Error(errMsg))
    } else {
      this.emitSuccess(null, { response: respObj })
    }

    this.cleanUp()
  }

  /**
   * Upload a stream to S3.
   */
  uploadS3Multipart (stream) {
    if (!this.options.s3) {
      this.emitRetry(new Error('The S3 client is not configured on this companion instance.'))
      return
    }

    const { client, options } = this.options.s3

    const upload = client.upload({
      Bucket: options.bucket,
      Key: options.getKey(null, this.uploadFileName, this.options.metadata),
      ACL: options.acl,
      ContentType: this.options.metadata.type,
      Body: stream
    })

    this.s3Upload = upload

    upload.on('httpUploadProgress', ({ loaded, total }) => {
      this.emitProgress(loaded, total)
    })

    upload.send((error, data) => {
      this.s3Upload = null
      if (error) {
        this.emitRetry(error)
      } else {
        const url = data && data.Location ? data.Location : null
        this.emitSuccess(url, {
          response: {
            responseText: JSON.stringify(data),
            headers: {
              'content-type': 'application/json'
            }
          }
        })
      }
      this.cleanUp()
    })
  }
}

Uploader.FILE_NAME_PREFIX = 'uppy-file'
Uploader.STORAGE_PREFIX = 'companion'

module.exports = Uploader
