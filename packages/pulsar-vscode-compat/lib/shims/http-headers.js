'use strict';

// VSCode extensions normally run in an extension host with Node-style HTTP
// clients. In Pulsar they currently execute in the renderer, so browser-backed
// clients such as axios' XHR adapter may try to set Node-only request headers.
// Chromium refuses those with noisy console errors like:
//   Refused to set unsafe header "User-Agent"
// The request would proceed without that header anyway, so ignore those writes
// before Chromium logs them.

const PATCH_FLAG = '__pulsarVscodeCompatUnsafeHeaderPatch';

const FORBIDDEN_REQUEST_HEADERS = new Set([
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'connection',
  'content-length',
  'cookie',
  'cookie2',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'permissions-policy',
  'referer',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'user-agent',
  'via'
]);

function isForbiddenRequestHeaderName(name) {
  const normalized = String(name || '').trim().toLowerCase();
  if (!normalized) return false;
  if (FORBIDDEN_REQUEST_HEADERS.has(normalized)) return true;
  return normalized.startsWith('proxy-') || normalized.startsWith('sec-');
}

function patchXMLHttpRequestUnsafeHeaders() {
  const XHR = typeof XMLHttpRequest !== 'undefined' && XMLHttpRequest;
  if (!XHR || !XHR.prototype || typeof XHR.prototype.setRequestHeader !== 'function') {
    return false;
  }

  const proto = XHR.prototype;
  if (proto[PATCH_FLAG]) return true;

  const originalSetRequestHeader = proto.setRequestHeader;
  Object.defineProperty(proto, PATCH_FLAG, {
    configurable: true,
    enumerable: false,
    writable: false,
    value: true
  });

  Object.defineProperty(proto, 'setRequestHeader', {
    configurable: true,
    enumerable: false,
    writable: true,
    value(name, value) {
      if (isForbiddenRequestHeaderName(name)) return;
      return originalSetRequestHeader.call(this, name, value);
    }
  });

  return true;
}

function install() {
  patchXMLHttpRequestUnsafeHeaders();
}

module.exports = {
  install,
  isForbiddenRequestHeaderName,
  patchXMLHttpRequestUnsafeHeaders
};
