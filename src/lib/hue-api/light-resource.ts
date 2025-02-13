import { ResourceApi } from "./api.js";
import { LightEffect, LightResourceParams, LightResourceResponse, LightResourceResult } from "./types.js";

class LightResource {
  private readonly api: ResourceApi;

  constructor(api: ResourceApi) {
    this.api = api;
  }

  async getLights(): Promise<LightResourceResult> {
    return this.api.sendRequest("GET", "/clip/v2/resource/light");
  }

  async getLight(id: string): Promise<LightResourceResult> {
    return this.api.sendRequest("GET", `/clip/v2/resource/light/${id}`);
  }

  async setOn(id: string, on: boolean): Promise<LightResourceResponse> {
    return this.api.sendRequest("PUT", `/clip/v2/resource/light/${id}`, {
      on: { on }
    });
  }

  async setBrightness(id: string, brightness: number): Promise<LightResourceResponse> {
    return this.api.sendRequest("PUT", `/clip/v2/resource/light/${id}`, {
      dimming: {
        brightness: Math.max(1, Math.min(100, brightness))
      }
    });
  }

  async setColorTemperature(id: string, mirek: number): Promise<LightResourceResponse> {
    return this.api.sendRequest("PUT", `/clip/v2/resource/light/${id}`, {
      color_temperature: {
        mirek: Math.max(153, Math.min(500, mirek))
      }
    });
  }

  async setColor(id: string, x: number, y: number): Promise<LightResourceResponse> {
    return this.api.sendRequest("PUT", `/clip/v2/resource/light/${id}`, {
      color: {
        xy: {
          x: Math.max(0, Math.min(1, x)),
          y: Math.max(0, Math.min(1, y))
        }
      }
    });
  }

  // not sure if it's supported by UC, it is not in light attributes
  async setEffect(id: string, effect: LightEffect): Promise<LightResourceResponse> {
    return this.api.sendRequest("PUT", `/clip/v2/resource/light/${id}`, {
      effects: {
        effect: effect === "no_effect" ? undefined : effect,
        status: effect === "no_effect" ? "no_effect" : "active"
      }
    });
  }

  async updateLightState(id: string, params: Partial<LightResourceParams>) {
    return this.api.sendRequest("PUT", `/clip/v2/resource/light/${id}`, params);
  }
}

export default LightResource;
