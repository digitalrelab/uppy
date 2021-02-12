const Uploader = require('../Uploader')
const logger = require('../logger')
const { errorToResponse } = require('../provider/error')
const { retryWithDelay } = require('../helpers/utils')
const emitter = require('../emitter')
const { Transform } = require('stream')

const workerCount = process.env.COMPANION_WORKER_COUNT ? parseInt(process.env.COMPANION_WORKER_COUNT, 10) : 3

const queue = (() => {
  const state = {}

  const stateForKey = (key) => {
    if (!state[key]) {
      state[key] = {
        actions: [],
        workers: []
      }
    }

    return state[key]
  }

  class Worker {
    constructor (key) {
      this.key = key
      this.isDone = false
    }

    async start () {
      while (stateForKey(this.key).actions.length) {
        const action = stateForKey(this.key).actions.shift()
        try {
          await action()
        } catch (e) {
          logger.error(e, 'controller.get.worker.start')
        }
      }
      this.isDone = true
    }
  }

  return (key, action) => {
    const state = stateForKey(key)
    state.actions.push(action)
    state.workers = state.workers.filter((worker) => !worker.isDone)
    while (state.workers.length < workerCount) {
      const worker = new Worker(key)
      worker.start()
      state.workers.push(worker)
    }
  }
})()

function get (req, res, next) {
  const id = req.params.id
  const token = req.companion.providerToken
  const provider = req.companion.provider

  retryWithDelay({
    retryDelays: [5000, 10000, 15000, 15000],
    action: () => new Promise((resolve, reject) => provider.size({ id, token, query: req.query }, (err, size) => {
      if (err) {
        reject(err)
        return
      }

      resolve(size)
    }))
  }).then(
    (size) => {
      if (!size) {
        logger.error('unable to determine file size', 'controller.get.provider.size', req.id)
        return res.status(400).json({ message: 'unable to determine file size' })
      }

      logger.debug('Instantiating uploader.', null, req.id)
      let uploader = new Uploader(Uploader.reqToOptions(req, size))

      if (uploader.hasError()) {
        const response = uploader.getResponse()
        res.status(response.status).json(response.body)
        return
      }

      const getPerformDownload = (isLast) => () => {
        return new Promise((resolve, reject) => {
          logger.debug('Starting remote download.', null, req.id)

          const uploadHandler = (data) => {
            if (data.action === 'success') {
              finish()
              return
            }

            if (data.action === 'retry') {
              if (isLast) {
                uploader.emitError(Object.assign(new Error(), data.payload.error))
                finish()
                return
              }
              retry(Object.assign(new Error(), data.payload.error))
            }
          }

          const retry = (err) => {
            uploader.cancel()
            uploader = new Uploader({
              ...Uploader.reqToOptions(req, size),
              token: uploader.token
            })
            logger.error(err, 'controller.get.retry', req.id)
            finish(err)
          }

          const finish = (err) => {
            emitter().removeListener(uploader.token, uploadHandler)
            if (err) {
              reject(err)
              return
            }
            resolve()
          }

          emitter().on(uploader.token, uploadHandler)

          provider
            .download({ id, token, query: req.query })
            .then((stream) => {
              console.log('hello world')
              uploader.upload(stream.pipe(new Transform({
                transform: (chunk, encoding, callback) => {
                  console.log(typeof chunk)
                  console.log(chunk.constructor)
                  callback(null, chunk)
                }
              })))
            })
            .catch((err) => {
              if (isLast) {
                uploader.emitError(err)
                uploader.cleanUp()
                return
              }

              retry(err)
            })
        })
      }

      // wait till the client has connected to the socket, before starting
      // the download, so that the client can receive all download/upload progress.
      logger.debug('Waiting for socket connection before beginning remote download.', null, req.id)
      // waiting for socketReady.
      uploader.onSocketReady(() => {
        if (token) {
          queue(token, () => retryWithDelay({
            retryDelays: process.env.NODE_ENV === 'test' ? [] : [5000, 10000, 15000, 30000, 60000, 120000],
            action: getPerformDownload(false),
            lastAction: getPerformDownload(true)
          }))
        } else {
          getPerformDownload(true)()
        }
        logger.debug('Socket connection received.', null, req.id)
      })
      const response = uploader.getResponse()
      res.status(response.status).json(response.body)
    },
    (err) => {
      const errResp = errorToResponse(err)
      if (errResp) {
        res.status(errResp.code).json({ message: errResp.message })
        return
      }
      next(err)
    }
  )
}

module.exports = get
