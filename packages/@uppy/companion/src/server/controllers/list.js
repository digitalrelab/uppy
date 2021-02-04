const { errorToResponse } = require('../provider/error')
const { retryWithDelay } = require('../helpers/utils')

function list ({ query, params, companion }, res, next) {
  const token = companion.providerToken

  const getPerformList = (isLast) => () => {
    return new Promise((resolve, reject) => companion.provider.list({ companion, token, directory: params.id, query }, (err, data) => {
      if (err) {
        if (isLast) {
          const errResp = errorToResponse(err)
          if (errResp) {
            return res.status(errResp.code).json({ message: errResp.message })
          }
          next(err)
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
    retryDelays: [5000, 10000, 15000, 20000],
    action: getPerformList(false),
    lastAction: getPerformList(true)
  })
}

module.exports = list
