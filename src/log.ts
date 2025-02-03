/**
 * Central log functions.
 *
 * Use [debug](https://www.npmjs.com/package/debug) module for logging.
 *
 * @copyright (c) 2024 by Unfolded Circle ApS.
 * @license Mozilla Public License Version 2.0, see LICENSE for more details.
 */

import debugModule from "debug";

const log = {
  msgTrace: debugModule("philips-hue:msg"),
  debug: debugModule("philips-hue:debug"),
  info: debugModule("philips-hue:info"),
  warn: debugModule("philips-hue:warn"),
  error: debugModule("philips-hue:error")
};

export default log;
