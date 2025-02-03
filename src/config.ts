/**
 * This module implements the Spotify local configuration of the Remote Two/3 integration driver.
 *
 * @copyright (c) 2024 by Unfolded Circle ApS.
 * @license Mozilla Public License Version 2.0, see LICENSE for more details.
 */

import { LightFeatures } from "@unfoldedcircle/integration-api";
import fs from "fs";
import path from "path";

const CFG_FILENAME = "philips_hue_config.json";

export interface LightConfig {
  name: string;
  features: LightFeatures[];
}
interface PhilipsHueConfig {
  hub: { ip: string; username: string };
  lights: { [key: string]: LightConfig };
}

export type ConfigEvent =
  | { type: "light-added"; data: LightConfig & { id: string } }
  | { type: "light-updated"; data: LightConfig & { id: string } };

class Config {
  private config: PhilipsHueConfig = { hub: { ip: "", username: "" }, lights: {} };
  private configPath: string;
  private cb?: (event: ConfigEvent) => void;
  constructor(configDir: string, cb?: (event: ConfigEvent) => void) {
    this.configPath = path.join(configDir, CFG_FILENAME);
    this.loadFromFile();
    this.cb = cb;
  }

  public getHubConfig() {
    return this.config.hub;
  }

  public updateHubConfig(hub: Partial<PhilipsHueConfig["hub"]>) {
    this.config.hub = { ...this.config.hub, ...hub };
    this.saveToFile();
  }

  public addLight(id: string, light: LightConfig) {
    this.config.lights[id] = light;
    this.saveToFile();
    if (this.cb) {
      this.cb({ type: "light-added", data: { id, ...light } });
    }
  }

  public getLights() {
    return Object.entries(this.config.lights).map(([id, light]) => ({ id, ...light }));
  }

  public updateLight(id: string, light: LightConfig) {
    this.config.lights[id] = light;
    this.saveToFile();
  }

  public getLight(id: string): LightConfig | undefined {
    return this.config.lights[id];
  }

  private loadFromFile() {
    if (fs.existsSync(this.configPath)) {
      const data = fs.readFileSync(this.configPath, "utf-8");
      this.config = JSON.parse(data);
    } else {
      this.saveToFile();
    }
  }

  private saveToFile() {
    const data = JSON.stringify(this.config, null, 2);
    fs.writeFileSync(this.configPath, data, "utf-8");
  }
}

export default Config;
