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
  const features: LightFeatures[] = [];
  if (light.on) {
    features.push(LightFeatures.OnOff);
  }
  return features;
}
