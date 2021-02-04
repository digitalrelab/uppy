const { errorToResponse, ProviderAuthError } = require('../provider/error')
const { retryWithDelay } = require('../helpers/utils')

function list ({ query, params, companion }, res, next) {
  const token = companion.providerToken

  const sendError = (err) => {
    const errResp = errorToResponse(err)
    if (errResp) {
      return res.status(errResp.code).json({ message: errResp.message })
    }
    next(err)
  }

  const getPerformList = (isLast) => () => {
    return new Promise((resolve, reject) => companion.provider.list({ companion, token, directory: params.id, query }, (err, data) => {
      if (err) {
        if (isLast) {
          sendError(err)
          resolve()
          return
        }
        reject(err)
        return
      }

      res.json(data)
      resolve()
    }))
  }

  retryWithDelay({
    retryDelays: [5000, 10000, 10000, 10000, 10000],
    action: getPerformList(false),
    lastAction: getPerformList(true),
    errorIsRetryable: (err) => !(err instanceof ProviderAuthError) || !err.isAuthError
  }).catch((err) => sendError(err))
}

module.exports = list
