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

export function getHubUrl(ip: string) {
  return "https://" + ip;
}
