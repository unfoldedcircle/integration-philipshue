import HueApi, { ResourceApi } from "./api.js";
import { LightResourceResult } from "./types.js";

class LightResource {
  private readonly api: ResourceApi;

  constructor(api: ResourceApi) {
    this.api = api;
  }

  async getLights(): Promise<LightResourceResult> {
    return this.api.sendRequest("GET", "/clip/v2/resource/light");
  }
}

export default LightResource;
