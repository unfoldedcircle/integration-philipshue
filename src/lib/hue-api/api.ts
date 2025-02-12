import axios, { AxiosInstance } from "axios";
import https from "node:https";
import log from "../../log.js";
import { hueBridgeCA } from "./cert.js";
import LightResource from "./light-resource.js";
import { AuthenticateResult, AuthenticateSuccess, HubConfig } from "./types.js";

export interface ResourceApi {
  sendRequest(method: "GET" | "POST" | "PUT", endpoint: string, body?: any): Promise<any>;
}

class HueApi implements ResourceApi {
  private hubUrl: string;
  public readonly lightResource: LightResource;
  private axiosInstance: AxiosInstance;
  private bridgeId: string = "";

  constructor(hubUrl: string) {
    this.hubUrl = hubUrl;
    this.lightResource = new LightResource(this);
    this.axiosInstance = axios.create({
      baseURL: this.hubUrl,
      httpsAgent: new https.Agent({
        // ca: hueBridgeCA,
        rejectUnauthorized: false,
        checkServerIdentity: (_, cert) => {
          // const certCN = cert.subject.CN;
          // if (certCN.toLowerCase() !== this.bridgeId.toLowerCase()) {
          //   throw new Error("api.ts: Invalid bridge certificate");
          // }
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

  setBridgeId(bridgeId: string) {
    this.bridgeId = bridgeId;
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
    log.debug("philips hue api request", { method, endpoint });
    if (!this.axiosInstance.defaults.headers.common["hue-application-key"]) {
      throw new Error("auth key is required in protected resource", { cause: "auth_key_required" });
    }
    try {
      const { data } = await this.axiosInstance.request({
        method,
        url: endpoint,
        data: body
      });
      return data;
    } catch (error: any) {
      // axios error handing, taken from docs
      if (error.response) {
        // The request was made and the server responded with a status code
        // that falls out of the range of 2xx
        console.log(error.response.data);
        console.log(error.response.status);
        console.log(error.response.headers);
      } else if (error.request) {
        // The request was made but no response was received
        console.log(error.request);
      } else {
        // Something happened in setting up the request that triggered an Error
        console.log("Error", error.message);
      }
    }
  }
}

export default HueApi;
