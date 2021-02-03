const Uploader = require('../Uploader')
const logger = require('../logger')
const { errorToResponse } = require('../provider/error')
const { retryWithDelay } = require('../helpers/utils')

const workerCount = process.env.COMPANION_WORKER_COUNT ? parseInt(process.env.COMPANION_WORKER_COUNT, 10) : 3

const queue = (() => {
  const state = {}

  const stateForTenantId = (tenantId) => {
    if (!state[tenantId]) {
      state[tenantId] = {
        actions: [],
        workers: []
      }
    }

    return state[tenantId]
  }

  class Worker {
    constructor (tenantId) {
      this.tenantId = tenantId
      this.isDone = false
    }

    async start () {
      while (stateForTenantId(this.tenantId).actions.length) {
        const action = stateForTenantId(this.tenantId).actions.shift()
        await action()
      }
      this.isDone = true
    }
  }

  return (tenantId, action) => {
    const state = stateForTenantId(tenantId)
    state.actions.push(action)
    state.workers = state.workers.filter((worker) => !worker.isDone)
    while (state.workers.length < workerCount) {
      const worker = new Worker(tenantId)
      worker.start()
      state.workers.push(worker)
    }
  }
})()

function get (req, res, next) {
  const id = req.params.id
  const token = req.companion.providerToken
  const provider = req.companion.provider

  const tenantId = req.body.metadata && req.body.metadata.tenantId

  // get the file size before proceeding
  provider.size({ id, token, query: req.query }, (err, size) => {
    if (err) {
      const errResp = errorToResponse(err)
      if (errResp) {
        return res.status(errResp.code).json({ message: errResp.message })
      }
      return next(err)
    }

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
        provider.download({ id, token, query: req.query }, (err, data) => {
          if (err) {
            if (isLast) {
              // Send error to client if last retry
              uploader.handleChunk(err, data)
              resolve()
              return
            }
            // Otherwise clean up and try again
            uploader.cleanUp()
            uploader = new Uploader(Uploader.reqToOptions(req, size))
            reject(err)
            return
          }

          if (data === null) {
            resolve()
          }

          uploader.handleChunk(err, data)
        })
      })
    }

    // wait till the client has connected to the socket, before starting
    // the download, so that the client can receive all download/upload progress.
    logger.debug('Waiting for socket connection before beginning remote download.', null, req.id)
    // waiting for socketReady.
    uploader.onSocketReady(() => {
      if (tenantId) {
        queue(tenantId, () => retryWithDelay({
          retryDelays: [5000, 10000, 15000, 30000, 60000, 120000],
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
  })
}

module.exports = get
