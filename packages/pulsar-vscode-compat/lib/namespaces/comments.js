'use strict';

const { Disposable } = require('../types/disposable');

function createCommentController(id, label) {
  return {
    id, label,
    commentingRangeProvider: undefined,
    reactionHandler: undefined,
    options: undefined,
    createCommentThread(uri, range, comments) {
      return {
        uri, range, comments, collapsibleState: 0, canReply: true, contextValue: undefined, label: undefined,
        dispose() {}
      };
    },
    dispose() {}
  };
}

module.exports = { createCommentController };
