/**
 * Utility functions.
 *
 * @copyright (c) 2024 by Unfolded Circle ApS.
 * @license Mozilla Public License Version 2.0, see LICENSE for more details.
 */

import { LightFeatures } from "@unfoldedcircle/integration-api";
import fs from "fs";
import { CombinedGroupResource, GamutTriangle, GamutType, GroupType, LightResource } from "./lib/hue-api/types.js";
import i18n from "i18n";
import log from "./log.js";
import Config, { GroupConfig, LightConfig } from "./config.js";

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

export function addAvailableLights(lights: LightResource[], config: Config) {
  lights.forEach((light) => {
    if (config.getLight(light.id)) {
      log.info("Light with id %s already exists in config, skipping", light.id);
      return;
    }
    const features = getLightFeatures(light);
    config.addLight(light.id, {
      id_v1: light.id_v1,
      name: light.metadata.name,
      features,
      gamut_type: light.color?.gamut_type,
      gamut: light.color?.gamut,
      mirek_schema: light.color_temperature?.mirek_schema
    } as LightConfig);
  });
}

export function addAvailableGroups(groups: CombinedGroupResource[], groupType: GroupType, config: Config) {
  groups.forEach((group) => {
    if (config.getLight(group.id)) {
      log.info("Group with id %s already exists in config, skipping", group.id);
      return;
    }
    const features = getGroupFeatures(group);
    config.addLight(group.id, {
      name: group.metadata.name,
      features,
      groupedLightIds: group.grouped_lights.map((gl) => gl.id),
      childLightIds: group.lights.map((light) => light.id),
      groupType,
      gamut_type: getMostCommonGamut(group),
      gamut: getRepresentativeGamutTriangle(group),
      mirek_schema: getMinMaxMirek(group)
    } as GroupConfig);
  });
}

export function getLightFeatures(light: LightResource): LightFeatures[] {
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

export function getGroupFeatures(group: CombinedGroupResource): LightFeatures[] {
  const features: LightFeatures[] = [LightFeatures.OnOff, LightFeatures.Toggle];
  let hasDim = false;
  let hasColorTemperature = false;
  let hasColor = false;

  for (const groupLight of group.grouped_lights) {
    if (!hasDim && groupLight.dimming) {
      hasDim = true;
    }
    if (!hasColorTemperature && groupLight.color_temperature?.mirek_schema) {
      hasColorTemperature = true;
    }
    if (!hasColor && groupLight.color?.xy) {
      hasColor = true;
    }
    if (hasDim && hasColorTemperature && hasColor) {
      break;
    }
  }

  if (!(hasDim && hasColorTemperature && hasColor)) {
    for (const childLight of group.lights) {
      if (!hasDim && childLight.dimming) {
        hasDim = true;
      }
      if (!hasColorTemperature && childLight.color_temperature?.mirek_schema) {
        hasColorTemperature = true;
      }
      if (!hasColor && childLight.color?.xy) {
        hasColor = true;
      }
      if (hasDim && hasColorTemperature && hasColor) {
        break;
      }
    }
  }
  if (hasDim) {
    features.push(LightFeatures.Dim);
  }
  if (hasColorTemperature) {
    features.push(LightFeatures.ColorTemperature);
  }
  if (hasColor) {
    features.push(LightFeatures.Color);
  }

  return features;
}

export function getMostCommonGamut(group: CombinedGroupResource): GamutType | undefined {
  const gamutTypes = group.lights
    .map((light) => light.color?.gamut_type)
    .filter((gamut): gamut is GamutType => gamut !== undefined);

  if (!gamutTypes) return undefined;

  const gamutCounts = gamutTypes.reduce(
    (acc, gamut) => {
      acc[gamut] = (acc[gamut] || 0) + 1;
      return acc;
    },
    {} as Record<GamutType, number>
  );
  return Object.entries(gamutCounts).sort((a, b) => b[1] - a[1])[0]?.[0] as GamutType | undefined;
}

export function getMinMaxMirek(
  group: CombinedGroupResource
): { mirek_minimum: number; mirek_maximum: number } | undefined {
  const mirekSchemas = group.lights
    .map((light) => light.color_temperature?.mirek_schema)
    .filter((schema): schema is { mirek_minimum: number; mirek_maximum: number } => schema !== undefined);
  return mirekSchemas.length > 0
    ? {
        mirek_minimum: Math.min(...mirekSchemas.map((s) => s.mirek_minimum)),
        mirek_maximum: Math.max(...mirekSchemas.map((s) => s.mirek_maximum))
      }
    : undefined;
}

// Safe fallback xy point when conversion input is invalid or effectively black.
const DEFAULT_XY = { x: 0.3, y: 0.3 };
// Small floor value to avoid division-by-zero in xy -> XYZ math.
const EPSILON = 0.000001;
// Standard CIE 1931 2° D65 white point. Used as the origin when expressing a
// bulb's color as "how far from white" (gamut-relative saturation) on readback.
const D65: { x: number; y: number } = { x: 0.3127, y: 0.329 };

/**
 * Pick a representative gamut triangle for a mixed group by choosing the triangle
 * from a light whose gamut_type matches the most-common one in the group.
 *
 * A true per-group triangle intersection would be an irregular polygon; same-generation
 * bulbs report near-identical triangles so the representative-bulb approach is an
 * acceptable substitute.
 *
 * @param group The combined group resource.
 * @returns The gamut triangle of the representative light, or undefined if none.
 */
export function getRepresentativeGamutTriangle(group: CombinedGroupResource): GamutTriangle | undefined {
  const mostCommon = getMostCommonGamut(group);
  if (!mostCommon) return undefined;
  return group.lights.find((l) => l.color?.gamut_type === mostCommon)?.color?.gamut;
}

// Clamps numeric values to a closed range.
function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

// Convert sRGB channel values to linear RGB (gamma expansion).
function gammaCorrect(channel: number) {
  return channel > 0.04045 ? Math.pow((channel + 0.055) / 1.055, 2.4) : channel / 12.92;
}

// Convert linear RGB channel values back to sRGB (inverse gamma expansion).
function inverseGammaCorrect(channel: number) {
  return channel <= 0.0031308 ? 12.92 * channel : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;
}

/**
 * Validate that a gamut triangle has non-zero area.
 */
function isValidGamut(gamut: GamutTriangle): boolean {
  // cross product of (green-red) × (blue-red); zero means collinear/degenerate
  const v1x = gamut.green.x - gamut.red.x;
  const v1y = gamut.green.y - gamut.red.y;
  const v2x = gamut.blue.x - gamut.red.x;
  const v2y = gamut.blue.y - gamut.red.y;
  return Math.abs(v1x * v2y - v1y * v2x) > EPSILON;
}

/**
 * Check whether a point lies within (or on the edge of) a gamut triangle.
 */
function isPointInTriangle(px: number, py: number, gamut: GamutTriangle): boolean {
  const v1x = gamut.green.x - gamut.red.x;
  const v1y = gamut.green.y - gamut.red.y;
  const v2x = gamut.blue.x - gamut.red.x;
  const v2y = gamut.blue.y - gamut.red.y;
  const qx = px - gamut.red.x;
  const qy = py - gamut.red.y;
  const denominator = v1x * v2y - v1y * v2x;
  if (Math.abs(denominator) <= EPSILON) return false;
  const s = (qx * v2y - qy * v2x) / denominator;
  const t = (v1x * qy - v1y * qx) / denominator;
  return s >= 0 && t >= 0 && s + t <= 1;
}

/**
 * Project a point onto a line segment and clamp the result to segment bounds.
 */
function closestPointOnSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): { x: number; y: number } {
  const abx = bx - ax;
  const aby = by - ay;
  const ab2 = abx * abx + aby * aby;
  if (ab2 <= EPSILON) return { x: ax, y: ay };
  const t = clamp(((px - ax) * abx + (py - ay) * aby) / ab2, 0, 1);
  return { x: ax + t * abx, y: ay + t * aby };
}

/**
 * Clip an xy coordinate to the nearest point inside a gamut triangle.
 *
 * If gamut data is missing/invalid or the point is already in range, the input is returned unchanged.
 */
function clipXYToGamut(x: number, y: number, gamut?: GamutTriangle): { x: number; y: number } {
  if (!gamut || !isValidGamut(gamut) || isPointInTriangle(x, y, gamut)) {
    return { x, y };
  }

  const pRG = closestPointOnSegment(x, y, gamut.red.x, gamut.red.y, gamut.green.x, gamut.green.y);
  const pGB = closestPointOnSegment(x, y, gamut.green.x, gamut.green.y, gamut.blue.x, gamut.blue.y);
  const pBR = closestPointOnSegment(x, y, gamut.blue.x, gamut.blue.y, gamut.red.x, gamut.red.y);

  const d2 = (p: { x: number; y: number }) => (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y);
  const dRG = d2(pRG);
  const dGB = d2(pGB);
  const dBR = d2(pBR);

  if (dRG <= dGB && dRG <= dBR) return pRG;
  if (dGB <= dBR) return pGB;
  return pBR;
}

/**
 * Compute gamut-relative saturation: the ratio of |xy - D65| to the distance
 * from D65 to the gamut-triangle boundary along the same ray. Returns a value
 * in [0, 1] where 0 is white (D65) and 1 is the gamut edge.
 *
 * This differs from sRGB-HSV saturation, which measures "distance to nearest
 * sRGB primary" in gamma-encoded sRGB space. sRGB-HSV only returns 1 when xy
 * aligns with a Wide RGB D65 primary direction; for most hues the bulb's
 * gamut corner is off-axis and sRGB-HSV under-reports saturation even when
 * the bulb is physically at its gamut edge — symptom: the UC wheel's dot sits
 * inside the boundary at max bulb saturation for most hues, and contracts
 * toward center faster than the Hue app as xy moves radially inward.
 *
 * Gamut-relative saturation matches the UC remote wheel's UX semantic — outer
 * edge = maximum achievable saturation at this hue for this bulb — and the
 * Hue app's wheel behavior. It is NOT the mathematical inverse of
 * convertHSVtoXY (which follows the Philips-docs HSV→sRGB→xy pipeline), so
 * round-tripping HSV → xy → HSV is approximate rather than exact when this
 * path is used.
 *
 * Ray-edge intersection is solved per edge via a 2×2 linear system. For a
 * point inside or on the triangle, exactly one edge yields t > 0 and
 * u ∈ [0, 1]; tied intersections at a vertex resolve to the same t.
 */
function computeGamutRelativeSaturation(xy: { x: number; y: number }, gamut: GamutTriangle): number {
  const dx = xy.x - D65.x;
  const dy = xy.y - D65.y;
  if (dx * dx + dy * dy <= EPSILON * EPSILON) return 0;

  const edges: Array<[{ x: number; y: number }, { x: number; y: number }]> = [
    [gamut.red, gamut.green],
    [gamut.green, gamut.blue],
    [gamut.blue, gamut.red]
  ];

  let tEdge = Infinity;
  for (const [A, B] of edges) {
    const ex = B.x - A.x;
    const ey = B.y - A.y;
    // Solve u * edge - t * dir = D65 - A  (where dir = xy - D65).
    // denom = cross(edge, dir); zero means the ray is parallel to this edge.
    const denom = ex * dy - ey * dx;
    if (Math.abs(denom) <= EPSILON) continue;
    const rx = D65.x - A.x;
    const ry = D65.y - A.y;
    const u = (rx * dy - ry * dx) / denom;
    const t = (rx * ey - ry * ex) / denom;
    if (u >= -EPSILON && u <= 1 + EPSILON && t > EPSILON && t < tEdge) {
      tEdge = t;
    }
  }

  if (!Number.isFinite(tEdge)) return 0;
  return clamp(1 / tEdge, 0, 1);
}

/**
 * Convert CIE xy to HSV hue and saturation.
 *
 * Brightness is intentionally not a parameter: it scales XYZ uniformly and
 * cancels out under the subsequent max-channel normalisation, so the output
 * HSV is invariant to it. Callers handle brightness separately via the
 * CLIP v2 `dimming.brightness` channel.
 *
 * IMPORTANT — intentional round-trip divergence when `gamut` is supplied:
 * the saturation returned is NOT the mathematical inverse of `convertHSVtoXY`.
 * When a gamut is available this function substitutes a gamut-relative
 * saturation (`|xy − D65|` normalised to the distance from D65 to the gamut
 * boundary along the D65→xy ray) for the sRGB-HSV saturation that would
 * otherwise be the inverse. This is deliberate: the UC remote wheel and the
 * Hue app wheel are gamut-calibrated (outer edge = max achievable saturation
 * for the bulb at that hue), and sRGB-HSV saturation only reaches 1 when xy
 * lies along a Wide-RGB-D65 primary axis — for every other hue the bulb's
 * gamut corner is off-axis and sRGB-HSV under-reports, so the UC dot would
 * sit inside the wheel boundary even when the bulb is physically maxed out.
 * Consequence: `HSV → xy → HSV` does not round-trip exactly along the
 * gamut-provided path; the hue component is stable but the saturation
 * component is the gamut-relative measure. Do not "fix" this by reverting
 * to sRGB-HSV saturation without replacing the wheel semantic. See
 * `computeGamutRelativeSaturation` for the derivation.
 *
 * @param x CIE x coordinate.
 * @param y CIE y coordinate.
 * @param gamut Optional lamp gamut triangle; when provided, xy is clipped before conversion
 *   AND saturation is reported as gamut-relative (see note above).
 * @returns HSV values with hue in 0..359 and saturation in 0..255.
 */
export function convertXYtoHSV(x: number, y: number, gamut?: GamutTriangle) {
  // Invalid/degenerate xyY input maps to a neutral HSV fallback.
  if (!Number.isFinite(x) || !Number.isFinite(y) || y <= 0) {
    return { hue: 0, sat: 0 };
  }

  const safeX = clamp(x, 0, 1);
  const safeY = clamp(y, EPSILON, 1);
  const clippedXY = clipXYToGamut(safeX, safeY, gamut);
  // Y scale is arbitrary: the subsequent max-channel normalise removes it.
  const Y = 1;
  const X = (Y / clippedXY.y) * clippedXY.x;
  const Z = (Y / clippedXY.y) * (1 - clippedXY.x - clippedXY.y);

  // Convert XYZ to linear RGB using the Wide RGB D65 matrix.
  let r = X * 1.656492 + Y * -0.354851 + Z * -0.255038;
  let g = X * -0.707196 + Y * 1.655397 + Z * 0.036152;
  let b = X * 0.051713 + Y * -0.121364 + Z * 1.01153;

  // Shift negative channels to keep relative color information before normalization.
  const minRgb = Math.min(r, g, b);
  if (minRgb < 0) {
    r -= minRgb;
    g -= minRgb;
    b -= minRgb;
  }

  let maxRgb = Math.max(r, g, b);
  if (maxRgb <= 0) {
    return { hue: 0, sat: 0 };
  }

  if (maxRgb > 1) {
    r /= maxRgb;
    g /= maxRgb;
    b /= maxRgb;
  }

  // Apply inverse gamma to return from linear RGB to display-style sRGB channels.
  r = inverseGammaCorrect(r);
  g = inverseGammaCorrect(g);
  b = inverseGammaCorrect(b);

  maxRgb = Math.max(r, g, b);
  if (maxRgb <= 0) {
    return { hue: 0, sat: 0 };
  }

  if (maxRgb > 1) {
    r /= maxRgb;
    g /= maxRgb;
    b /= maxRgb;
    maxRgb = 1;
  }

  const minSRgb = Math.min(r, g, b);
  const span = maxRgb - minSRgb;
  let sat = span === 0 ? 0 : Math.round((span / maxRgb) * 255);

  let H: number;
  if (span === 0) {
    H = 0;
  } else if (maxRgb === r) {
    H = 60 * (((g - b) / span) % 6);
  } else if (maxRgb === g) {
    H = 60 * ((b - r) / span + 2);
  } else {
    H = 60 * ((r - g) / span + 4);
  }
  if (H < 0) {
    H += 360;
  }

  // When a bulb gamut is available, override the sRGB-HSV saturation with a
  // gamut-relative measure so the reported value matches what a gamut-calibrated
  // UI (UC remote wheel, Hue app wheel) expects: 255 at the gamut edge, 0 at
  // D65, linear in radial distance between. sRGB-HSV — what we'd otherwise
  // return — compresses saturation for hue angles where the bulb's gamut corner
  // is off-axis from the Wide RGB D65 primaries, which produces a visible
  // mismatch with the Hue app during radial drags. See
  // computeGamutRelativeSaturation for the full rationale; this path is
  // intentionally NOT the mathematical inverse of convertHSVtoXY.
  if (gamut && isValidGamut(gamut)) {
    sat = Math.round(computeGamutRelativeSaturation(clippedXY, gamut) * 255);
  }

  return {
    hue: Math.round(H) % 360,
    sat: clamp(sat, 0, 255)
  };
}

/**
 * Convert HSV hue and saturation to CIE xy.
 *
 * HSV "value" (brightness) is intentionally not a parameter: in the Hue CLIP v2
 * model chromaticity and luminance are orthogonal (color.xy vs. dimming.brightness),
 * and coupling a value into this conversion introduces a non-linear shift in the
 * computed xy via the sRGB gamma-decode step. Callers set brightness separately
 * via `dimming.brightness`.
 *
 * @param hue Hue in degrees (0..360, wrapped if out of range).
 * @param saturation Saturation in 0..255.
 * @param gamut Optional lamp gamut triangle; when provided, xy is clipped before return.
 * @returns CIE xy coordinates.
 */
export function convertHSVtoXY(hue: number, saturation: number, gamut?: GamutTriangle) {
  // Invalid HSV input maps to the known safe default xy point.
  if (!Number.isFinite(hue) || !Number.isFinite(saturation)) {
    return DEFAULT_XY;
  }

  const normalizedHue = ((hue % 360) + 360) % 360;
  const h = normalizedHue / 60;
  const s = clamp(saturation / 255, 0, 1);

  // Value fixed at 1: brightness is an orthogonal axis set via dimming.brightness.
  const c = s;
  const xComponent = c * (1 - Math.abs((h % 2) - 1));
  const m = 1 - c;

  let r, g, b;
  if (h >= 0 && h < 1) {
    [r, g, b] = [c, xComponent, 0];
  } else if (h < 2) {
    [r, g, b] = [xComponent, c, 0];
  } else if (h < 3) {
    [r, g, b] = [0, c, xComponent];
  } else if (h < 4) {
    [r, g, b] = [0, xComponent, c];
  } else if (h < 5) {
    [r, g, b] = [xComponent, 0, c];
  } else {
    [r, g, b] = [c, 0, xComponent];
  }

  [r, g, b] = [r + m, g + m, b + m];

  if (Math.max(r, g, b) <= 0) {
    return DEFAULT_XY;
  }

  // Apply gamma before transforming sRGB channels into XYZ space.
  r = gammaCorrect(r);
  g = gammaCorrect(g);
  b = gammaCorrect(b);

  // Convert linear RGB to XYZ using Philips's "Wide RGB D65" matrix.
  // Note: the narrative section of the Hue Color Conversion docs (step 3 under
  // "RGB to xy") lists the standard sRGB→XYZ D65 coefficients (0.4124, 0.3576,
  // ...) but labels them "Wide RGB D65" — that's a documentation error. The
  // coefficients used here are from the iOS SDK extract in the same doc and are
  // the mathematical inverse of the XYZ→RGB matrix used in convertXYtoHSV, so
  // they are what keeps forward/reverse conversions self-consistent.
  const X = r * 0.664511 + g * 0.154324 + b * 0.162028;
  const Y = r * 0.283881 + g * 0.668433 + b * 0.047685;
  const Z = r * 0.000088 + g * 0.07231 + b * 0.986039;
  const sum = X + Y + Z;

  if (sum <= 0) {
    return DEFAULT_XY;
  }

  // Clamp to valid xy bounds to avoid propagating floating point noise.
  const xy = {
    x: clamp(X / sum, 0, 1),
    y: clamp(Y / sum, 0, 1)
  };
  return clipXYToGamut(xy.x, xy.y, gamut);
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

export function mirekToColorTemp(colorTemp: number, minMirek: number, maxMirek: number) {
  if (isNaN(colorTemp) || colorTemp <= minMirek) {
    return 0;
  }
  if (colorTemp >= maxMirek) {
    return 100;
  }
  const range = maxMirek - minMirek;
  return ((colorTemp - minMirek) / range) * 100;
}

export function colorTempToMirek(colorTemp: number, minMirek: number, maxMirek: number) {
  if (isNaN(colorTemp) || colorTemp <= 0) {
    return minMirek;
  }
  if (colorTemp >= 100) {
    return maxMirek;
  }
  const range = maxMirek - minMirek;
  return Math.round((colorTemp / 100) * range + minMirek);
}

/**
 * Convert a brightness value to a percentage
 * @param brightness - 0 - 255
 * @returns The brightness value as a percentage (1-100)
 */
export function brightnessToPercent(brightness: number) {
  if (isNaN(brightness) || brightness <= 0) {
    return 1;
  }
  if (brightness >= 255) {
    return 100;
  }
  return Math.max(1, Math.round((brightness / 255) * 100));
}

export function percentToBrightness(percent: number) {
  if (isNaN(percent) || percent <= 0) {
    return 1;
  }
  if (percent >= 100) {
    return 255;
  }
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

/**
 * Performs a deep comparison between two values to determine if they are equivalent.
 *
 * Object fields set to `undefined` are ignored.
 *
 * @param a The first value to compare.
 * @param b The second value to compare.
 * @returns True if the values are equivalent, false otherwise.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isDeepEqual(a: any, b: any): boolean {
  if (a === b) {
    return true;
  }

  if (a && b && typeof a === "object" && typeof b === "object") {
    if (a.constructor !== b.constructor) {
      return false;
    }

    if (Array.isArray(a)) {
      if (a.length !== b.length) {
        return false;
      }
      for (let i = 0; i < a.length; i++) {
        if (!isDeepEqual(a[i], b[i])) {
          return false;
        }
      }
      return true;
    }

    const keysA = Object.keys(a).filter((k) => a[k] !== undefined);
    const keysB = Object.keys(b).filter((k) => b[k] !== undefined);

    if (keysA.length !== keysB.length) {
      return false;
    }

    for (const key of keysA) {
      if (!keysB.includes(key)) {
        return false;
      }
      if (!isDeepEqual(a[key], b[key])) {
        return false;
      }
    }
    return true;
  }

  return a !== a && b !== b;
}
