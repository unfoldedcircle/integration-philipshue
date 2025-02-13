import { LightFeatures } from "@unfoldedcircle/integration-api";
import fs from "fs";
import { LightResource } from "./lib/hue-api/types.js";

export function convertImageToBase64(file: string) {
  let data;

  try {
    data = fs.readFileSync(file, "base64");
  } catch (e) {
    console.error(e);
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
  var Y = lightness;
  var X = (x / y) * Y;
  var Z = ((1 - x - y) / y) * Y;

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

  let ScaledS = Math.round(S * 255);

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

export function getHubUrl(ip: string) {
  return "https://" + ip;
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
