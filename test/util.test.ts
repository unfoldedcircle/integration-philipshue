import test from "ava";
import {
  brightnessToPercent,
  colorTempToMirek,
  convertHSVtoXY,
  convertXYtoHSV,
  getHubUrl,
  isValidHttpUrl,
  mirekToColorTemp,
  normalizeBridgeId,
  percentToBrightness,
  getLightFeatures,
  getGroupFeatures,
  getMostCommonGamut,
  getMinMaxMirek,
  delay,
  convertImageToBase64,
  i18all
} from "../src/util.js";
import { LightFeatures } from "@unfoldedcircle/integration-api";
import { CombinedGroupResource, LightResource } from "../src/lib/hue-api/types.js";
import fs from "fs";
import i18n from "i18n";

// --- Brightness & Percent ---

test("brightnessToPercent converts 0-255 to 1-100", (t) => {
  t.is(brightnessToPercent(0), 1);
  t.is(brightnessToPercent(255), 100);
  t.is(brightnessToPercent(127), 50);
  t.is(brightnessToPercent(128), 50);
});

test("brightnessToPercent handles invalid values", (t) => {
  t.is(brightnessToPercent(-1), 1);
  t.is(brightnessToPercent(256), 100);
  t.is(brightnessToPercent(NaN), 1);
  t.is(brightnessToPercent(Infinity), 100);
});

test("percentToBrightness converts 1-100 to 1-255", (t) => {
  t.is(percentToBrightness(0), 1);
  t.is(percentToBrightness(1), 3);
  t.is(percentToBrightness(50), 128);
  t.is(percentToBrightness(100), 255);
});

test("percentToBrightness handles invalid values", (t) => {
  t.is(percentToBrightness(-1), 1);
  t.is(percentToBrightness(101), 255);
  t.is(percentToBrightness(NaN), 1);
  t.is(percentToBrightness(Infinity), 255);
});

// --- Color Temperature & Mirek ---

test("mirekToColorTemp converts 153-500 to 0-100", (t) => {
  t.is(mirekToColorTemp(153), 0);
  t.is(mirekToColorTemp(500), 100);
  t.is(Math.round(mirekToColorTemp(326.5)), 50);
});

test("mirekToColorTemp handles invalid values", (t) => {
  t.is(mirekToColorTemp(152), 0);
  t.is(mirekToColorTemp(501), 100);
  t.is(mirekToColorTemp(NaN), 0);
  t.is(mirekToColorTemp(Infinity), 100);
});

test("colorTempToMirek converts 0-100 to 153-500", (t) => {
  t.is(colorTempToMirek(0), 153);
  t.is(colorTempToMirek(100), 500);
  t.is(colorTempToMirek(50), 327);
});

test("colorTempToMirek handles invalid values", (t) => {
  t.is(colorTempToMirek(-1), 153);
  t.is(colorTempToMirek(101), 500);
  t.is(colorTempToMirek(NaN), 153);
  t.is(colorTempToMirek(Infinity), 500);
});

// --- HSV & XY Conversions ---

test("convertXYtoHSV handles zero values", (t) => {
  // make sure y = 0 doesn't cause division by zero
  t.notThrows(() => convertXYtoHSV(0.4, 0));
  const result = convertXYtoHSV(0.4, 0);
  t.is(typeof result.hue, "number");
  t.is(typeof result.sat, "number");
});

test("convertXYtoHSV handles black/zero lightness", (t) => {
  // make sure lightness = 0 doesn't cause division by zero
  const result = convertXYtoHSV(0.4, 0.4, 0);
  t.is(result.hue, 0);
  t.is(result.sat, 0);
});

test("convertXYtoHSV and convertHSVtoXY round-trip (approximate)", (t) => {
  const x = 0.4;
  const y = 0.4;
  const hsv = convertXYtoHSV(x, y);
  const xy = convertHSVtoXY(hsv.hue, hsv.sat, 1);

  t.true(Math.abs(xy.x - x) < 0.1, `x: ${xy.x} vs ${x}`);
  t.true(Math.abs(xy.y - y) < 0.1, `y: ${xy.y} vs ${y}`);
});

test("convertHSVtoXY handles black (sum=0)", (t) => {
  const xy = convertHSVtoXY(0, 0, 0);
  t.is(xy.x, 0.3);
  t.is(xy.y, 0.3);
});

test("convertXYtoHSV handles different sectors", (t) => {
  // Use known primary/secondary colors in RGB
  // We'll use the reverse conversion to get XY values that should map to these

  // Red (H=0, S=255, V=1) -> XY
  const xyRed = convertHSVtoXY(0, 255, 1);
  const hsvRed = convertXYtoHSV(xyRed.x, xyRed.y);
  t.true(hsvRed.hue === 0 || hsvRed.hue === 359 || hsvRed.hue === 360);
  t.is(hsvRed.sat, 255);

  // Green (H=120, S=255, V=1) -> XY
  const xyGreen = convertHSVtoXY(120, 255, 1);
  const hsvGreen = convertXYtoHSV(xyGreen.x, xyGreen.y);
  t.is(hsvGreen.hue, 120);
  t.is(hsvGreen.sat, 255);

  // Blue (H=240, S=255, V=1) -> XY
  const xyBlue = convertHSVtoXY(240, 255, 1);
  const hsvBlue = convertXYtoHSV(xyBlue.x, xyBlue.y);
  t.is(hsvBlue.hue, 240);
  t.is(hsvBlue.sat, 255);

  // Yellow (H=60, S=255, V=1) -> XY
  const xyYellow = convertHSVtoXY(60, 255, 1);
  const hsvYellow = convertXYtoHSV(xyYellow.x, xyYellow.y);
  t.is(hsvYellow.hue, 60);

  // Cyan (H=180, S=255, V=1) -> XY
  const xyCyan = convertHSVtoXY(180, 255, 1);
  const hsvCyan = convertXYtoHSV(xyCyan.x, xyCyan.y);
  t.is(hsvCyan.hue, 180);

  // Magenta (H=300, S=255, V=1) -> XY
  const xyMagenta = convertHSVtoXY(300, 255, 1);
  const hsvMagenta = convertXYtoHSV(xyMagenta.x, xyMagenta.y);
  t.is(hsvMagenta.hue, 300);
});

test("convertXYtoHSV handles min max boundary values", (t) => {
  // x, y are usually between 0 and 1
  const hsv11 = convertXYtoHSV(1, 1);
  t.is(typeof hsv11.hue, "number");
  t.is(hsv11.sat, 255);

  const hsv01 = convertXYtoHSV(0, 1);
  t.is(typeof hsv01.hue, "number");
  t.is(hsv01.sat, 255);

  t.deepEqual(convertXYtoHSV(1, 0), { hue: 0, sat: 0 });
});

// --- Hub URL & Validation ---

test("isValidHttpUrl validates URLs", (t) => {
  t.true(isValidHttpUrl("http://192.168.1.1"));
  t.true(isValidHttpUrl("https://hue-bridge.local"));
  t.false(isValidHttpUrl("not-a-url"));
  t.false(isValidHttpUrl("ftp://192.168.1.1"));
});

test("getHubUrl formats IP/hostname to HTTPS URL", (t) => {
  t.is(getHubUrl("192.168.1.1"), "https://192.168.1.1");
  t.is(getHubUrl("HUE-BRIDGE"), "https://hue-bridge");
  t.is(getHubUrl("http://192.168.1.1"), "https://192.168.1.1");
  t.is(getHubUrl("https://192.168.1.1/api"), "https://192.168.1.1");
});

test("getHubUrl throws on invalid input", (t) => {
  // The current implementation is very lenient because URL constructor can handle many things
  // But something completely broken should still fail if it's not a valid URL
  // Actually, getHubUrl prepends https://, so "!!!" becomes "https://!!!" which URL() might accept in some environments
  // Let's find something that truly fails isValidHttpUrl
  t.throws(() => getHubUrl("   "));
});

// --- Normalize Bridge ID ---

test("normalizeBridgeId handles various formats", (t) => {
  // Zeroconf format
  t.is(normalizeBridgeId("00:11:22:33:44:55"), "001122334455");
  // nupnp format
  t.is(normalizeBridgeId("001122fffe334455"), "001122334455");
  // Standard format
  t.is(normalizeBridgeId("001122334455"), "001122334455");
  // Unexpected format (returns as is, lowercased)
  t.is(normalizeBridgeId("SHORT"), "short");
});

// --- Light & Group Features ---

test("getLightFeatures detects features", (t) => {
  const light = {
    on: { on: true },
    dimming: { brightness: 100 },
    color_temperature: { mirek_schema: { mirek_minimum: 153, mirek_maximum: 500 } },
    color: { xy: { x: 0.1, y: 0.1 } }
  } as unknown as LightResource;
  const features = getLightFeatures(light);
  t.true(features.includes(LightFeatures.OnOff));
  t.true(features.includes(LightFeatures.Dim));
  t.true(features.includes(LightFeatures.ColorTemperature));
  t.true(features.includes(LightFeatures.Color));

  const basicLight = { on: { on: true } } as unknown as LightResource;
  const basicFeatures = getLightFeatures(basicLight);
  t.deepEqual(basicFeatures, [LightFeatures.OnOff, LightFeatures.Toggle]);
});

test("getGroupFeatures detects features from lights and grouped_lights", (t) => {
  const group = {
    lights: [{ dimming: {} }, { color_temperature: { mirek_schema: {} } }],
    grouped_lights: [{ color: { xy: {} } }]
  } as unknown as CombinedGroupResource;
  const features = getGroupFeatures(group);
  t.true(features.includes(LightFeatures.OnOff));
  t.true(features.includes(LightFeatures.Dim));
  t.true(features.includes(LightFeatures.ColorTemperature));
  t.true(features.includes(LightFeatures.Color));
});

// --- Gamut & Mirek range ---

test("getMostCommonGamut returns most frequent gamut", (t) => {
  const group = {
    lights: [{ color: { gamut_type: "A" } }, { color: { gamut_type: "B" } }, { color: { gamut_type: "B" } }]
  } as unknown as CombinedGroupResource;
  t.is(getMostCommonGamut(group), "B");
});

test("getMostCommonGamut returns undefined if no gamut", (t) => {
  const group = {
    lights: [{}]
  } as unknown as CombinedGroupResource;
  t.is(getMostCommonGamut(group), undefined);
});

test("getMinMaxMirek returns min/max from all lights", (t) => {
  const group = {
    lights: [
      { color_temperature: { mirek_schema: { mirek_minimum: 150, mirek_maximum: 300 } } },
      { color_temperature: { mirek_schema: { mirek_minimum: 200, mirek_maximum: 500 } } }
    ]
  } as unknown as CombinedGroupResource;
  const range = getMinMaxMirek(group);
  t.is(range?.mirek_minimum, 150);
  t.is(range?.mirek_maximum, 500);
});

// --- Utilities ---

test("delay waits for specified time", async (t) => {
  const start = Date.now();
  await delay(100);
  const duration = Date.now() - start;
  t.true(duration >= 90); // Allow some jitter
});

test("convertImageToBase64 reads file as base64", (t) => {
  const mockFile = "test-image.txt";
  const content = "Hello World";
  fs.writeFileSync(mockFile, content);

  try {
    const base64 = convertImageToBase64(mockFile);
    t.is(base64, Buffer.from(content).toString("base64"));
  } finally {
    fs.unlinkSync(mockFile);
  }
});

test("convertImageToBase64 returns undefined on error", (t) => {
  const base64 = convertImageToBase64("non-existent-file.jpg");
  t.is(base64, undefined);
});

// --- i18n ---

test("i18all returns translations", (t) => {
  const originalH = i18n.__h;
  // Mock i18n.__h
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  i18n.__h = (key: string): any => {
    if (key === "test_key") {
      return [{ en: "Test" }, { de: "Test DE" }, { fr: "test_key" }];
    }
    return [];
  };

  try {
    const result = i18all("test_key");
    t.is(result.en, "Test");
    t.is(result.de, "Test DE");
    t.false("fr" in result); // Skipped because untranslated

    const emptyResult = i18all("unknown");
    t.is(emptyResult.en, "unknown");
  } finally {
    i18n.__h = originalH;
  }
});
