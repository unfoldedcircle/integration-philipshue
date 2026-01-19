/**
 * Philips Hue API for the Remote Two/3 integration driver.
 *
 * @copyright (c) 2024 by Unfolded Circle ApS.
 * @license Mozilla Public License Version 2.0, see LICENSE for more details.
 */

import { HueError, ResourceApi } from "./api.js";
import { StatusCodes } from "@unfoldedcircle/integration-api";
import {
  LightEffect,
  LightResource as LightResourceData,
  LightResourceParams,
  LightResourceResponse,
  LightResourceResult
} from "./types.js";

class LightResource {
  private readonly api: ResourceApi;

  constructor(api: ResourceApi) {
    this.api = api;
  }

  async getLights(): Promise<LightResourceData[]> {
    const res = await this.api.sendRequest<LightResourceResult>("GET", "/clip/v2/resource/light");
    return res.data;
  }

  async getLight(id: string): Promise<LightResourceData> {
    const res = await this.api.sendRequest<LightResourceResult>("GET", `/clip/v2/resource/light/${id}`);
    if (!res.data || res.data.length === 0) {
      throw new HueError("Light not found", StatusCodes.NotFound);
    }
    return res.data[0];
  }

  async setOn(id: string, on: boolean): Promise<LightResourceResponse["data"]> {
    const res = await this.api.sendRequest<LightResourceResponse>("PUT", `/clip/v2/resource/light/${id}`, {
      on: { on }
    });
    return res.data;
  }

  async setBrightness(id: string, brightness: number): Promise<LightResourceResponse["data"]> {
    const res = await this.api.sendRequest<LightResourceResponse>("PUT", `/clip/v2/resource/light/${id}`, {
      dimming: {
        brightness: Math.max(1, Math.min(100, brightness))
      }
    });
    return res.data;
  }

  async setColorTemperature(id: string, mirek: number): Promise<LightResourceResponse["data"]> {
    const res = await this.api.sendRequest<LightResourceResponse>("PUT", `/clip/v2/resource/light/${id}`, {
      color_temperature: {
        mirek: Math.max(153, Math.min(500, mirek))
      }
    });
    return res.data;
  }

  async setColor(id: string, x: number, y: number): Promise<LightResourceResponse["data"]> {
    const res = await this.api.sendRequest<LightResourceResponse>("PUT", `/clip/v2/resource/light/${id}`, {
      color: {
        xy: {
          x: Math.max(0, Math.min(1, x)),
          y: Math.max(0, Math.min(1, y))
        }
      }
    });
    return res.data;
  }

  // not sure if it's supported by UC, it is not in light attributes
  async setEffect(id: string, effect: LightEffect): Promise<LightResourceResponse["data"]> {
    const res = await this.api.sendRequest<LightResourceResponse>("PUT", `/clip/v2/resource/light/${id}`, {
      effects: {
        effect: effect === "no_effect" ? undefined : effect,
        status: effect === "no_effect" ? "no_effect" : "active"
      }
    });
    return res.data;
  }

  async updateLightState(id: string, params: Partial<LightResourceParams>): Promise<LightResourceResponse["data"]> {
    const res = await this.api.sendRequest<LightResourceResponse>("PUT", `/clip/v2/resource/light/${id}`, params);
    return res.data;
  }
}

export default LightResource;
