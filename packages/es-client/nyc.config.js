'use strict';

module.exports = {
  extends: '../../nyc.config.js',
  include: [
    '*.js',
    'lib/*.js',
  ],
  'exclude-after-remap': false,
};
