/** Throw fail(400, 'Plain-English reason') from any handler; the error middleware sends it. */
class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function fail(status, message, extra) {
  throw new HttpError(status, message, extra);
}

/** Optimistic locking: the browser sends back the version it loaded. */
function checkVersion(row, sentVersion, noun = 'record') {
  if (sentVersion === undefined || sentVersion === null || sentVersion === '') return;
  if (Number(sentVersion) !== Number(row.version)) {
    fail(409, `Someone else changed this ${noun} while you were editing. Close this form, reload, and try again.`);
  }
}

module.exports = { HttpError, fail, checkVersion };
