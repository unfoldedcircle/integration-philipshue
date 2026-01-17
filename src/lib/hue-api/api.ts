/**
 * Philips Hue API for the Remote Two/3 integration driver.
 *
 * @copyright (c) 2024 by Unfolded Circle ApS.
 * @license Mozilla Public License Version 2.0, see LICENSE for more details.
 */

import axios, { AxiosInstance } from "axios";
import https from "node:https";
import log from "../../log.js";
import LightResource from "./light-resource.js";
import { AuthenticateResult, AuthenticateSuccess, HubConfig } from "./types.js";

export interface ResourceApi {
  sendRequest(method: "GET" | "POST" | "PUT", endpoint: string, body?: any): Promise<any>;
}

class HueApi implements ResourceApi {
  private hubUrl: string;
  private requestTimeout: number;
  public readonly lightResource: LightResource;
  private axiosInstance: AxiosInstance;

  constructor(hubUrl: string, requestTimeout: number = 2000) {
    this.hubUrl = hubUrl;
    this.requestTimeout = requestTimeout;
    this.lightResource = new LightResource(this);
    this.axiosInstance = axios.create({
      baseURL: this.hubUrl,
      httpsAgent: new https.Agent({
        rejectUnauthorized: false,
        checkServerIdentity: () => {
          return undefined;
        }
      })
    });
  }

  setBaseUrl(hubUrl: string) {
    this.hubUrl = hubUrl;
    this.axiosInstance.defaults.baseURL = hubUrl;
  }

  setAuthKey(authKey: string) {
    this.axiosInstance.defaults.headers.common["hue-application-key"] = authKey;
  }

  async getHubConfig() {
    const hubHttp = this.hubUrl.replace("https://", "http://");
    const { data } = await this.axiosInstance.get<HubConfig>(`${hubHttp}/api/config`);
    return data;
  }

  async generateAuthKey(deviceType: string): Promise<AuthenticateSuccess> {
    // return { username: "15S7kBmqpeYkXF1d9nnKjCV03yWgL2w3UMXBEH3C", clientkey: "6B1E833A8D532972A27C256E5A3D4A98" };
    const { data } = await this.axiosInstance.post<AuthenticateResult[]>(`${this.hubUrl}/api`, {
      devicetype: deviceType,
      generateclientkey: true
    });
    if (!data[0]?.success) {
      throw new Error(`Failed to generate auth key: ${data[0]?.error?.description}`);
    }
    return data[0].success;
  }

  async sendRequest(method: "GET" | "POST" | "PUT", endpoint: string, body?: any): Promise<any> {
    log.msgTrace("philips hue api request", { method, endpoint });
    if (!this.axiosInstance.defaults.headers.common["hue-application-key"]) {
      throw new Error("auth key is required in protected resource", { cause: "auth_key_required" });
    }
    try {
      const { data } = await this.axiosInstance.request({
        method,
        url: endpoint,
        data: body,
        timeout: this.requestTimeout
      });
      return data;
    } catch (error: any) {
      // FIXME return error code
      // axios error handing, taken from docs
      if (error.response) {
        log.error("philips hue api response error (%s %s)", method, endpoint, error.response.data);
      } else if (error.request) {
        log.error("philips hue api request error (%s %s) %s: %s", method, endpoint, error.code, error.message);
      } else {
        log.error("philips hue api unknown error (%s %s)", method, endpoint, error.message);
      }
    }
  }
}

export default HueApi;
