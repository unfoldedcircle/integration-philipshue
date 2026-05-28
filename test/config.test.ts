import test, { ExecutionContext, TestFn } from "ava";
import Config, { LightOrGroupConfig, SceneConfig } from "../src/config.js";
import fs from "fs";
import path from "path";
import os from "os";
import { LightFeatures } from "@unfoldedcircle/integration-api";

interface TestContext {
  tmpDir: string;
}

const configTest = test as TestFn<TestContext>;

configTest.beforeEach((t: ExecutionContext<TestContext>) => {
  t.context.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hue-config-test-"));
});

configTest.afterEach.always((t: ExecutionContext<TestContext>) => {
  if (t.context.tmpDir) {
    fs.rmSync(t.context.tmpDir, { recursive: true, force: true });
  }
});

configTest("updateLight saves only when changed", (t: ExecutionContext<TestContext>) => {
  const config = new Config(t.context.tmpDir);
  const lightId = "light1";
  const light: LightOrGroupConfig = {
    name: "Light 1",
    features: [LightFeatures.OnOff, LightFeatures.Dim]
  };

  // 1. Add light (initial save)
  config.addLight(lightId, light);

  // 2. Spy on fs.writeFileSync
  const originalWriteFileSync = fs.writeFileSync;
  let writeCount = 0;
  fs.writeFileSync = (
    p: string | number | URL | Buffer,
    data: string | NodeJS.ArrayBufferView,
    options?: fs.WriteFileOptions
  ) => {
    if (typeof p === "string" && p.includes("philips_hue_config.json")) {
      writeCount++;
    }
    return originalWriteFileSync(p, data, options);
  };

  try {
    // 3. Update with same data
    config.updateLight(lightId, { ...light });
    t.is(writeCount, 0, "Should not have written to file when data is identical");

    // 4. Update with changed data (top level)
    const changedLight: LightOrGroupConfig = {
      name: "Light 1 Updated",
      features: [LightFeatures.OnOff, LightFeatures.Dim]
    };
    config.updateLight(lightId, changedLight);
    t.is(writeCount, 1, "Should have written to file when name changed");

    // 5. Update with same data again
    writeCount = 0;
    config.updateLight(lightId, { ...changedLight });
    t.is(writeCount, 0, "Should not have written to file when data is identical again");

    // 6. Update with nested change (array)
    const nestedChangedLight: LightOrGroupConfig = {
      name: "Light 1 Updated",
      features: [LightFeatures.OnOff] // Changed array
    };
    writeCount = 0;
    config.updateLight(lightId, nestedChangedLight);
    t.is(writeCount, 1, "Should have written to file when features array changed");

    // 7. Update with nested change (object)
    const lightWithMirek: LightOrGroupConfig = {
      name: "Light 1 Updated",
      features: [LightFeatures.OnOff],
      mirek_schema: { mirek_minimum: 153, mirek_maximum: 500 }
    };
    writeCount = 0;
    config.updateLight(lightId, lightWithMirek);
    t.is(writeCount, 1, "Should have written to file when mirek_schema added");

    writeCount = 0;
    config.updateLight(lightId, {
      ...lightWithMirek,
      mirek_schema: { mirek_minimum: 153, mirek_maximum: 450 } // Changed nested object
    });
    t.is(writeCount, 1, "Should have written to file when mirek_schema property changed");
  } finally {
    // Restore original writeFileSync
    fs.writeFileSync = originalWriteFileSync;
  }
});

configTest(
  "updateLight doesn't save when optional field is undefined and missing in config",
  (t: ExecutionContext<TestContext>) => {
    const config = new Config(t.context.tmpDir);
    const lightId = "light1";
    const light: LightOrGroupConfig = {
      name: "Light 1",
      features: [LightFeatures.OnOff]
    };

    config.addLight(lightId, light);

    const originalWriteFileSync = fs.writeFileSync;
    let writeCount = 0;
    fs.writeFileSync = (
      p: string | number | URL | Buffer,
      data: string | NodeJS.ArrayBufferView,
      options?: fs.WriteFileOptions
    ) => {
      if (typeof p === "string" && p.includes("philips_hue_config.json")) {
        writeCount++;
      }
      return originalWriteFileSync(p, data, options);
    };

    try {
      // gamut_type is missing in config, but provided as undefined in update
      config.updateLight(lightId, {
        ...light,
        gamut_type: undefined
      } as unknown as LightOrGroupConfig);
      t.is(writeCount, 0, "Should not save when new optional field is undefined");

      // mirek_schema is missing in config, but provided as undefined in update
      config.updateLight(lightId, {
        ...light,
        mirek_schema: undefined
      } as unknown as LightOrGroupConfig);
      t.is(writeCount, 0, "Should not save when new optional field mirek_schema is undefined");
    } finally {
      fs.writeFileSync = originalWriteFileSync;
    }
  }
);

configTest("addScene then getScenes round-trips all SceneConfig fields", (t: ExecutionContext<TestContext>) => {
  const config = new Config(t.context.tmpDir);
  const sceneId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const scene: SceneConfig = {
    name: "Sunset",
    groupId: "11111111-1111-1111-1111-111111111111",
    groupRtype: "room",
    groupName: "Living Room"
  };

  config.addScene(sceneId, scene);

  t.deepEqual(config.getScene(sceneId), scene);

  const all = config.getScenes();
  t.is(all.length, 1);
  t.deepEqual(all[0], { id: sceneId, ...scene });
});

configTest("updateScene short-circuits when content is identical", (t: ExecutionContext<TestContext>) => {
  const config = new Config(t.context.tmpDir);
  const sceneId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const scene: SceneConfig = {
    name: "Sunset",
    groupId: "11111111-1111-1111-1111-111111111111",
    groupRtype: "room",
    groupName: "Living Room"
  };

  config.addScene(sceneId, scene);

  const originalWriteFileSync = fs.writeFileSync;
  let writeCount = 0;
  fs.writeFileSync = (
    p: string | number | URL | Buffer,
    data: string | NodeJS.ArrayBufferView,
    options?: fs.WriteFileOptions
  ) => {
    if (typeof p === "string" && p.includes("philips_hue_config.json")) {
      writeCount++;
    }
    return originalWriteFileSync(p, data, options);
  };

  try {
    config.updateScene(sceneId, { ...scene });
    t.is(writeCount, 0, "Should not write when SceneConfig is unchanged");

    config.updateScene(sceneId, { ...scene, name: "Sunset Glow" });
    t.is(writeCount, 1, "Should write when scene name changes");

    writeCount = 0;
    config.updateScene(sceneId, { ...scene, name: "Sunset Glow", groupName: "Den" });
    t.is(writeCount, 1, "Should write when groupName changes");
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }
});

configTest("removeScene removes the entry; removeScenes wipes the map", (t: ExecutionContext<TestContext>) => {
  const config = new Config(t.context.tmpDir);
  const a = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const b = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const base: Omit<SceneConfig, "name"> = {
    groupId: "11111111-1111-1111-1111-111111111111",
    groupRtype: "room",
    groupName: "Living Room"
  };

  config.addScene(a, { name: "Sunset", ...base });
  config.addScene(b, { name: "Movie", ...base });
  t.is(config.getScenes().length, 2);

  config.removeScene(a);
  t.is(config.getScene(a), undefined);
  t.is(config.getScenes().length, 1);

  config.removeScenes();
  t.deepEqual(config.getScenes(), []);
});
