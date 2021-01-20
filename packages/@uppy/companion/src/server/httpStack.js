// Modified from https://github.com/tus/tus-js-client/blob/master/lib/node/httpStack.js

const http = require("http");
const https = require("https");
const { parse } = require("url");
const { Readable, Transform } = require("stream");
const throttle = require("lodash.throttle");
const cookieParser = require('set-cookie-parser');

class UppyHttpStack {
  constructor(requestOptions = {}) {
    this._requestOptions = requestOptions;
    this._cookies = {};
  }

  createRequest(method, url) {
    return new Request(method, url, this._requestOptions, {
      getCookies: () => this._cookies,
      setCookies: (cookies) => this._cookies = cookies,
    });
  }

  getName() {
    return "UppyHttpStack";
  }
}

class Request {
  constructor(method, url, options, cookieOptions) {
    this._method = method;
    this._url = url;
    this._headers = {};
    this._request = null;
    this._progressHandler = function () {};
    this._requestOptions = options || {};
    this._cookieOptions = cookieOptions;
  }

  getMethod() {
    return this._method;
  }

  getURL() {
    return this._url;
  }

  setHeader(header, value) {
    this._headers[header] = value;
  }

  getHeader(header) {
    return this._headers[header];
  }

  setProgressHandler(progressHandler) {
    this._progressHandler = progressHandler;
  }

  send(body = null) {
    return new Promise((resolve, reject) => {
      const cookies = this._cookieOptions.getCookies();
      const options = {
        ...parse(this._url),
        ...this._requestOptions,

        method: this._method,
        headers: {
          ...(this._requestOptions.headers || {}),
          ...this._headers,
          ...cookies.length && {
            Cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`),
          },
        }
      };

      if (body && body.size) {
        options.headers["Content-Length"] = body.size;
      }

      const httpModule = options.protocol === "https:" ? https : http;
      const req = this._request = httpModule.request(options);
      req.on("response", (res) => {
        const resChunks = [];
        res.on("data", (data) => {
          resChunks.push(data);
        });

        res.on("end", () => {
          const setCookie = res.headers['set-cookie'];
          if (setCookie && setCookie.length) {
            const parsedCookies = cookieParser.parse(setCookie, {
              decodeValues: false,
            });
            this._cookieOptions.setCookies(parsedCookies);
          }
          const responseText = Buffer.concat(resChunks).toString("utf8");
          resolve(new Response(res, responseText));
        });
      });

      req.on("error", (err) => {
        reject(err);
      });

      if (body instanceof Readable) {
        body.pipe(new ProgressEmitter(this._progressHandler)).pipe(req);
      } else {
        req.end(body);
      }
    });
  }

  abort() {
    if (this._request !== null) this._request.abort();
    return Promise.resolve();
  }

  getUnderlyingObject() {
    return this._request;
  }
}

class Response {
  constructor(res, body) {
    this._response = res;
    this._body = body;
  }

  getStatus() {
    return this._response.statusCode;
  }

  getHeader(header) {
    return this._response.headers[header.toLowerCase()];
  }

  getBody() {
    return this._body;
  }

  getUnderlyingObject() {
    return this._response;
  }
}

// ProgressEmitter is a simple PassThrough-style transform stream which keeps
// track of the number of bytes which have been piped through it and will
// invoke the `onprogress` function whenever new number are available.
class ProgressEmitter extends Transform {
  constructor(onprogress) {
    super();

    // The _onprogress property will be invoked, whenever a chunk is piped
    // through this transformer. Since chunks are usually quite small (64kb),
    // these calls can occur frequently, especially when you have a good
    // connection to the remote server. Therefore, we are throtteling them to
    // prevent accessive function calls.
    this._onprogress = throttle(onprogress, 100, {
      leading: true,
      trailing: false
    });
    this._position = 0;
  }

  _transform(chunk, encoding, callback) {
    this._position += chunk.length;
    this._onprogress(this._position);
    callback(null, chunk);
  }
}

module.exports = UppyHttpStack;
