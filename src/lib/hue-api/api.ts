import axios, { AxiosInstance } from "axios";
import https from "node:https";
import log from "../../log.js";
import LightResource from "./light-resource.js";
import { AuthenticateSuccess, HubConfig } from "./types.js";

const hueBridgeCA = `-----BEGIN CERTIFICATE-----
MIICMjCCAdigAwIBAgIUO7FSLbaxikuXAljzVaurLXWmFw4wCgYIKoZIzj0EAwIw
OTELMAkGA1UEBhMCTkwxFDASBgNVBAoMC1BoaWxpcHMgSHVlMRQwEgYDVQQDDAty
b290LWJyaWRnZTAiGA8yMDE3MDEwMTAwMDAwMFoYDzIwMzgwMTE5MDMxNDA3WjA5
MQswCQYDVQQGEwJOTDEUMBIGA1UECgwLUGhpbGlwcyBIdWUxFDASBgNVBAMMC3Jv
b3QtYnJpZGdlMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEjNw2tx2AplOf9x86
aTdvEcL1FU65QDxziKvBpW9XXSIcibAeQiKxegpq8Exbr9v6LBnYbna2VcaK0G22
jOKkTqOBuTCBtjAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBhjAdBgNV
HQ4EFgQUZ2ONTFrDT6o8ItRnKfqWKnHFGmQwdAYDVR0jBG0wa4AUZ2ONTFrDT6o8
ItRnKfqWKnHFGmShPaQ7MDkxCzAJBgNVBAYTAk5MMRQwEgYDVQQKDAtQaGlsaXBz
IEh1ZTEUMBIGA1UEAwwLcm9vdC1icmlkZ2WCFDuxUi22sYpLlwJY81Wrqy11phcO
MAoGCCqGSM49BAMCA0gAMEUCIEBYYEOsa07TH7E5MJnGw557lVkORgit2Rm1h3B2
sFgDAiEA1Fj/C3AN5psFMjo0//mrQebo0eKd3aWRx+pQY08mk48=
-----END CERTIFICATE-----`;

export interface ResourceApi {
  sendRequest(method: "GET" | "POST", endpoint: string, body?: any): Promise<any>;
}

class HueApi implements ResourceApi {
  private hubUrl: string;
  public readonly lightResource: LightResource;
  private axiosInstance: AxiosInstance;
  private bridgeId: string = "";
  constructor(hubUrl: string) {
    this.hubUrl = hubUrl;
    this.lightResource = new LightResource(this);

    this.axiosInstance = axios.default.create({
      baseURL: this.hubUrl,
      httpsAgent: new https.Agent({
        ca: hueBridgeCA,
        checkServerIdentity: (_, cert) => {
          const certCN = cert.subject.CN;
          if (certCN.toLowerCase() !== this.bridgeId.toLowerCase()) {
            throw new Error("Invalid bridge certificate");
          }
          return undefined;
        }
      })
    });
  }
  // using fetch api implement the below api calls

  //   ### get hub config
  // GET https://10.0.10.73/api/0/config HTTP/1.1

  // ### generate api key
  // POST https://10.0.10.73/api HTTP/1.1
  // Content-Type: application/json

  // {"devicetype":"app_name#instance_name", "generateclientkey":true}

  async setBaseUrl(hubUrl: string) {
    this.hubUrl = hubUrl;
    this.axiosInstance.defaults.baseURL = hubUrl;
  }

  async setAuthKey(authKey: string) {
    this.axiosInstance.defaults.headers.common["hue-application-key"] = authKey;
  }

  async getConfig(): Promise<any> {
    const hubHttp = this.hubUrl.replace("https://", "http://");
    const { data } = await this.axiosInstance.get<HubConfig>(`${hubHttp}/api/config`);
    this.bridgeId = data.bridgeid;
    return data;
  }

  async generateAuthKey(deviceType: string): Promise<AuthenticateSuccess> {
    return { username: "15S7kBmqpeYkXF1d9nnKjCV03yWgL2w3UMXBEH3C", clientkey: "6B1E833A8D532972A27C256E5A3D4A98" };
    // const { data } = await this.axiosInstance.post<AuthenticateResult[]>(`${this.hubUrl}/api`, {
    //   devicetype: deviceType,
    //   generateclientkey: true
    // });
    // if (!data[0]?.success) {
    //   throw new Error(`Failed to generate auth key: ${data[0]?.error?.description}`);
    // }
    // return data[0].success;
  }

  // async getHubDevices(): Promise<HubDeviceResult> {
  //   const response = await fetch(`${this.hubUrl}/clip/v2/resource/device`, {
  //     method: "GET",
  //     headers: {
  //       "hue-application-key": this.authKey
  //     }
  //   });
  //   if (!response.ok) {
  //     const respBody = await response.text();
  //     throw new Error(`Failed to get hub devices: ${response.statusText} ${respBody}`);
  //   }
  //   return response.json();
  // }

  async sendRequest(method: "GET" | "POST", endpoint: string, body?: any): Promise<any> {
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
