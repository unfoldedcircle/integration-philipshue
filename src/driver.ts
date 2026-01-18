/**
 * Remote Two/3 Philips Hue integration driver.
 *
 * @copyright (c) 2024 by Unfolded Circle ApS.
 * @license Mozilla Public License Version 2.0, see LICENSE for more details.
 */

import PhilipsHue from "./lib/philips-hue.js";
import log from "./log.js";

const philipsHue = new PhilipsHue();
philipsHue.init().catch((error: unknown) => {
  // log full error object, because this should not happen
  log.error("Initialization failed:", error);
  process.exit(1);
});
