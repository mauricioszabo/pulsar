'use strict';

function t(message, ...args) {
  // Try atom's i18n if available
  try {
    if (atom.i18n && typeof atom.i18n.t === 'function') {
      return atom.i18n.t(message, ...args);
    }
  } catch (e) {}

  // Simple argument substitution fallback
  let result = message;
  if (args.length === 1 && typeof args[0] === 'object' && !Array.isArray(args[0])) {
    const params = args[0];
    result = message.replace(/\{(\w+)\}/g, (_, key) => params[key] !== undefined ? String(params[key]) : `{${key}}`);
  } else {
    args.forEach((arg, i) => {
      result = result.replace(new RegExp(`\\{${i}\\}`, 'g'), String(arg));
    });
  }
  return result;
}

module.exports = { t, bundle: null, uri: null };
