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
  msgTrace: debugModule("uc_hue:msg"),
  debug: debugModule("uc_hue:debug"),
  info: debugModule("uc_hue:info"),
  warn: debugModule("uc_hue:warn"),
  error: debugModule("uc_hue:error")
};

export default log;
