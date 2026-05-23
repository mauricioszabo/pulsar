// HTTP helper for talking to the Pulsar registry. Uses the global `fetch`
// available in Electron's bundled Node, so we don't need superagent.

const npmrc = require('./npmrc');

// The registry returns metadata for 200/201/204, "not found" for 404; we want
// callers to handle those bodies themselves rather than throwing.
const OK_STATUS_CODES = new Set([200, 201, 204, 404]);

function buildHeaders(opts) {
  const headers = { 'User-Agent': npmrc.userAgent(), ...(opts.headers ?? {}) };
  if (opts.json) headers['Accept'] = 'application/json';
  return headers;
}

function buildUrl(url, qs) {
  if (!qs) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(qs)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, v);
  }
  return u.toString();
}

async function doFetch(url, init, retries) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, init);
      if (OK_STATUS_CODES.has(res.status)) return res;
      // Non-OK and not in our allowed list — retry if we still can.
      if (attempt === retries) {
        const err = new Error(`HTTP ${res.status} for ${url}`);
        err.status = res.status;
        err.response = res;
        throw err;
      }
    } catch (e) {
      lastErr = e;
      if (attempt === retries) throw e;
    }
  }
  throw lastErr;
}

async function bodyFor(res, opts) {
  const status = res.status;
  let body;
  if (opts.json) {
    const text = await res.text();
    try { body = text ? JSON.parse(text) : {}; }
    catch (_) { body = { rawText: text }; }
  } else {
    body = await res.text();
  }
  return { statusCode: status, body, headers: Object.fromEntries(res.headers.entries()) };
}

module.exports = {
  async get(opts) {
    const headers = buildHeaders(opts);
    const url = buildUrl(opts.url, opts.qs);
    const res = await doFetch(url, { method: 'GET', headers }, opts.retries ?? 0);
    return bodyFor(res, opts);
  },

  async del(opts) {
    const headers = buildHeaders(opts);
    const url = buildUrl(opts.url, opts.qs);
    const res = await doFetch(url, { method: 'DELETE', headers }, opts.retries ?? 0);
    return bodyFor(res, opts);
  },

  async post(opts) {
    const headers = buildHeaders(opts);
    if (opts.body !== undefined) headers['Content-Type'] ??= 'application/json';
    const url = buildUrl(opts.url, opts.qs);
    const init = { method: 'POST', headers };
    if (opts.body !== undefined) {
      init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    }
    const res = await doFetch(url, init, opts.retries ?? 0);
    return bodyFor(res, opts);
  },

  // Returns the underlying Response so the caller can stream the body.
  async stream(opts) {
    const headers = buildHeaders(opts);
    const url = buildUrl(opts.url, opts.qs);
    return doFetch(url, { method: 'GET', headers }, opts.retries ?? 0);
  },

  getErrorMessage(body, err) {
    if (err?.status === 503) {
      return `${err?.response?.url ?? 'registry'} is temporarily unavailable, please try again later.`;
    }
    return err?.message ?? body?.message ?? body?.error ?? String(body ?? err ?? 'Unknown error');
  }
};
