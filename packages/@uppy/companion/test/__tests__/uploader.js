/* global jest:false, test:false, expect:false, describe:false */

jest.mock('tus-js-client')

const Uploader = require('../../src/server/Uploader')
const socketClient = require('../mocksocket')
const { companionOptions } = require('../../src/standalone')

describe('uploader with tus protocol', () => {
  test('upload functions with tus protocol', () => {
    const fileContent = Buffer.from('Some file content')
    const opts = {
      companionOptions: companionOptions,
      endpoint: 'http://url.myendpoint.com/files',
      protocol: 'tus',
      size: fileContent.length,
      pathPrefix: companionOptions.filePath
    }

    const uploader = new Uploader(opts)
    const uploadToken = uploader.token
    expect(uploader.hasError()).toBe(false)
    expect(uploadToken).toBeTruthy()

    return new Promise((resolve) => {
      // validate that the test is resolved on socket connection
      uploader.onSocketReady(() => {
        uploader.handleChunk(null, fileContent)
        setTimeout(() => {
          expect(uploader.bytesWritten).toBeGreaterThan(0)
        }, 100)
      })

      let progressReceived = 0
      // emulate socket connection
      socketClient.connect(uploadToken)
      socketClient.onProgress(uploadToken, (message) => {
        progressReceived = message.payload.bytesUploaded
      })
      socketClient.onUploadSuccess(uploadToken, (message) => {
        expect(progressReceived).toBe(fileContent.length)
        // see __mocks__/tus-js-client.js
        expect(message.payload.url).toBe('https://tus.endpoint/files/foo-bar')
        resolve()
      })
    })
  })
})
