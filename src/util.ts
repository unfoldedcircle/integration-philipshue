/**
 * Utility functions.
 *
 * @copyright (c) 2024 by Unfolded Circle ApS.
 * @license Mozilla Public License Version 2.0, see LICENSE for more details.
 */

import { LightFeatures } from "@unfoldedcircle/integration-api";
import fs from "fs";
import { LightResource } from "./lib/hue-api/types.js";
import i18n from "i18n";
import log from "./log.js";

export function convertImageToBase64(file: string) {
  let data;

  try {
    data = fs.readFileSync(file, "base64");
  } catch (e: unknown) {
    log.error("Failed to read image file %s: %s", file, e instanceof Error ? e.message : e);
  }
  return data;
}

export function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getLightFeatures(light: LightResource) {
  const features: LightFeatures[] = [LightFeatures.OnOff, LightFeatures.Toggle];
  if (light.dimming) {
    features.push(LightFeatures.Dim);
  }
  if (light.color_temperature?.mirek_schema) {
    features.push(LightFeatures.ColorTemperature);
  }
  if (light.color?.xy) {
    features.push(LightFeatures.Color);
  }
  return features;
}

export function convertXYtoHSV(x: number, y: number, lightness = 1) {
  const Y = lightness;
  const X = (x / y) * Y;
  const Z = ((1 - x - y) / y) * Y;

  const R = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
  const G = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
  const B = 0.0557 * X - 0.204 * Y + 1.057 * Z;

  const V = Math.max(R, G, B);
  const minRGB = Math.min(R, G, B);
  const S = (V - minRGB) / V;

  let H = 0;
  if (V == minRGB) {
    H = 0;
  } else if (V == R && G >= B) {
    H = 60 * ((G - B) / (V - minRGB));
  } else if (V == R && G < B) {
    H = 60 * ((G - B) / (V - minRGB)) + 360;
  } else if (V == G) {
    H = 60 * ((B - R) / (V - minRGB)) + 120;
  } else if (V == B) {
    H = 60 * ((R - G) / (V - minRGB)) + 240;
  }

  const ScaledS = Math.round(S * 255);

  const res = {
    hue: Math.round(H) % 360,
    sat: Math.max(0, Math.min(ScaledS, 255))
  };

  return res;
}

export function convertHSVtoXY(hue: number, saturation: number, value: number) {
  const h = hue / 60;
  const s = saturation / 100;
  const v = value / 100;

  const c = v * s;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = v - c;

  let r, g, b;
  if (h >= 0 && h < 1) {
    [r, g, b] = [c, x, 0];
  } else if (h < 2) {
    [r, g, b] = [x, c, 0];
  } else if (h < 3) {
    [r, g, b] = [0, c, x];
  } else if (h < 4) {
    [r, g, b] = [0, x, c];
  } else if (h < 5) {
    [r, g, b] = [x, 0, c];
  } else {
    [r, g, b] = [c, 0, x];
  }

  [r, g, b] = [r + m, g + m, b + m];
  const X = 0.412453 * r + 0.35758 * g + 0.180423 * b;
  const Y = 0.212671 * r + 0.71516 * g + 0.072169 * b;
  const Z = 0.019334 * r + 0.119193 * g + 0.950227 * b;
  const sum = X + Y + Z;
  return {
    x: sum === 0 ? 0.3 : X / sum,
    y: sum === 0 ? 0.3 : Y / sum
  };
}

export function getHubUrl(ip: string): string {
  // best effort: even though the parameter should only be an IP or hostname, we try to parse URL's
  // Note: the `URL` class isn't a very good validator!
  const address =
    "https://" +
    ip
      .toLowerCase()
      .trim()
      .replace(/^https?:\/\//, "");

  if (!isValidHttpUrl(address)) {
    throw new Error("Invalid hub URL: " + address);
  }

  const url = new URL(address);
  return url.protocol + "//" + url.host;
}

export function isValidHttpUrl(url: string): boolean {
  try {
    const newUrl = new URL(url);
    return newUrl.protocol === "http:" || newUrl.protocol === "https:";
  } catch {
    return false;
  }
}

export function mirekToColorTemp(colorTemp: number) {
  // color temperature range is (integer – minimum: 153 – maximum: 500)
  // 347
  colorTemp = colorTemp - 153;
  return (colorTemp / 347) * 100;
}

export function colorTempToMirek(colorTemp: number) {
  colorTemp = (colorTemp / 100) * 347;
  return Math.round(colorTemp + 153);
}

/**
 * Convert a brightness value to a percentage
 * @param brightness - 0 - 255
 * @returns The brightness value as a percentage (1-100)
 */
export function brightnessToPercent(brightness: number) {
  return Math.max(1, Math.round((brightness / 255) * 100));
}

export function percentToBrightness(percent: number) {
  return Math.max(1, Math.round((percent / 100) * 255));
}

/**
 * Normalize a bridge ID.
 *
 * Logic from aiohue library.
 *
 * @param bridgeId The bridge ID to normalize.
 * @returns The normalized bridge ID.
 */
export function normalizeBridgeId(bridgeId: string): string {
  const id = bridgeId.toLowerCase();

  // zeroconf: properties['id'], field contains semicolons after each 2 char
  if (id.length === 17 && (id.match(/:/g) || []).length === 5) {
    return id.replace(/:/g, "");
  }

  // nupnp: contains 4 extra characters in the middle: "fffe"
  if (id.length === 16 && id.substring(6, 10) === "fffe") {
    return id.substring(0, 6) + id.substring(10);
  }

  // SSDP/UPNP and Hue Bridge API contains right ID.
  if (id.length === 12) {
    return id;
  }

  log.warn("Received unexpected bridge id: %s", bridgeId);

  return id;
}

/**
 * Returns an object of translations for a given phrase in each language.
 *
 * - The `i18n.__h` hashed list of translations is converted to an object with key values.
 *   - __h result for a given key: `[{en: "foo"},{de: "bar"}]`
 *   - Output: `{en: "foo", de: "bar"}`
 * - If a translation text is the same as the key, it is considered "untranslated" and skipped in the output.
 *   - __h result for given key `key42`: `[{en: "foo"},{de: "key42"},{fr: "key42"}]`
 *   - Output: `{en: "foo"}`
 * - If there are no translations, the english key is returned as value.
 *   - __h result for a given key: `[]`
 *   - Output: `{en: "${key}"}`
 *
 * @param key translation key
 * @return object containing translations for each language
 */
export function i18all(key: string): Record<string, string> {
  const out: Record<string, string> = {};
  i18n.__h(key).forEach((item) => {
    const lang = Object.keys(item)[0];
    // skip untranslated keys
    if (key !== item[lang]) {
      out[lang] = item[lang];
    }
  });
  if (Object.keys(out).length === 0) {
    out.en = key;
  }
  return out;
}
