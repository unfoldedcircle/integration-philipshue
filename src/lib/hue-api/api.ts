/**
 * Philips Hue API for the Remote Two/3 integration driver.
 *
 * @copyright (c) 2024 by Unfolded Circle ApS.
 * @license Mozilla Public License Version 2.0, see LICENSE for more details.
 */

import axios, { AxiosInstance } from "axios";
import https from "node:https";
import { StatusCodes } from "@unfoldedcircle/integration-api";
import log from "../../log.js";
import LightResource from "./light-resource.js";
import { AuthenticateResult, AuthenticateSuccess, HubConfig } from "./types.js";

export class HueError extends Error {
  constructor(
    message: string,
    public readonly statusCode: StatusCodes,
    cause?: unknown
  ) {
    super(message);
    this.name = "HueError";
    if (cause) {
      this.cause = cause;
    }
  }
}

export interface ResourceApi {
  /**
   * Send a request to the Philips Hue API.
   *
   * @param method The HTTP method (GET, POST, PUT).
   * @param endpoint The API endpoint.
   * @param body Optional request body.
   * @returns The API response data.
   * @throws {HueError} If the request fails or returns an error status.
   */
  sendRequest<T>(method: "GET" | "POST" | "PUT", endpoint: string, body?: unknown): Promise<T>;
}

class HueApi implements ResourceApi {
  private hubUrl: string;
  private requestTimeout: number;
  public readonly lightResource: LightResource;
  private axiosInstance: AxiosInstance;

  constructor(hubUrl: string, requestTimeout: number = 1500) {
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

  private handleError(error: unknown, method: string, endpoint: string): never {
    if (axios.isAxiosError(error)) {
      if (error.response) {
        log.error(
          "Philips Hue API response error (%s %s) %d: %j",
          method,
          endpoint,
          error.response.status,
          error.response.data
        );
        const status = error.response.status;
        switch (status) {
          case 400:
            throw new HueError("Bad request", StatusCodes.BadRequest, error);
          case 401:
          case 403:
            throw new HueError("Unauthorized", StatusCodes.Unauthorized, error);
          case 404:
            throw new HueError("Not found", StatusCodes.NotFound, error);
          default:
            throw new HueError(`API error: ${status}`, StatusCodes.ServerError, error);
        }
      } else if (error.request) {
        log.error("Philips Hue API request error (%s %s) %s: %s", method, endpoint, error.code, error.message);
        if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
          throw new HueError("Request timeout", StatusCodes.Timeout, error);
        }
        throw new HueError("Service unavailable", StatusCodes.ServiceUnavailable, error);
      }
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    log.error("Philips Hue API unknown error (%s %s) %s", method, endpoint, message);
    throw new HueError(message, StatusCodes.ServerError, error);
  }

  /**
   * Get the Hue hub configuration.
   *
   * @returns The hub configuration.
   * @throws {HueError} If the request fails.
   */
  async getHubConfig() {
    // TODO verify if new Hue pro hub still allows http access
    const hubHttp = this.hubUrl.replace("https://", "http://");
    try {
      const { data } = await this.axiosInstance.get<HubConfig>(`${hubHttp}/api/config`);
      return data;
    } catch (error) {
      this.handleError(error, "GET", `${hubHttp}/api/config`);
    }
  }

  /**
   * Generate an authentication key.
   *
   * @param deviceType The device type identifier.
   * @returns The authentication success details.
   * @throws {HueError} If the request fails or key generation is unsuccessful.
   */
  async generateAuthKey(deviceType: string): Promise<AuthenticateSuccess> {
    try {
      const { data } = await this.axiosInstance.post<AuthenticateResult[]>(`${this.hubUrl}/api`, {
        devicetype: deviceType,
        generateclientkey: true
      });
      if (!data[0]?.success) {
        throw new HueError(`Failed to generate auth key: ${data[0]?.error?.description}`, StatusCodes.BadRequest);
      }
      return data[0].success;
    } catch (error) {
      if (error instanceof HueError) {
        throw error;
      }
      this.handleError(error, "POST", `${this.hubUrl}/api`);
    }
  }

  async sendRequest<T>(method: "GET" | "POST" | "PUT", endpoint: string, body?: unknown): Promise<T> {
    log.msgTrace("Philips Hue API request: %s %s", method, endpoint);
    if (!this.axiosInstance.defaults.headers.common["hue-application-key"]) {
      throw new HueError("auth key is required in protected resource", StatusCodes.Unauthorized);
    }
    try {
      const { data } = await this.axiosInstance.request<T>({
        method,
        url: endpoint,
        data: body,
        timeout: this.requestTimeout
      });
      return data;
    } catch (error: unknown) {
      this.handleError(error, method, endpoint);
    }
  }
}

export default HueApi;
