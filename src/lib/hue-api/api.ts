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
import { delay, normalizeBridgeId } from "../../util.js";
import LightResource from "./light-resource.js";
import { AuthenticateResult, AuthenticateSuccess, HubConfig } from "./types.js";

const MAX_RETRIES = 3;

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
   * @param authRequired Whether an authentication key is required for this request.
   * @returns The API response data.
   * @throws {HueError} If the request fails or returns an error status.
   */
  sendRequest<T>(method: "GET" | "POST" | "PUT", endpoint: string, body?: unknown, authRequired?: boolean): Promise<T>;
}

class HueApi implements ResourceApi {
  private hubUrl?: string;
  public readonly lightResource: LightResource;
  private axiosInstance: AxiosInstance;

  constructor(hubUrl?: string, requestTimeout: number = 1500) {
    this.hubUrl = hubUrl;
    this.lightResource = new LightResource(this);
    this.axiosInstance = axios.create({
      baseURL: this.hubUrl,
      timeout: requestTimeout,
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
        const responseData = error.response.data;
        log.error(
          "Philips Hue API response error (%s %s) %d: %j",
          method,
          endpoint,
          error.response.status,
          responseData
        );

        // Try to extract a meaningful error message from the response body (V2 API)
        let message = "";
        if (responseData && Array.isArray(responseData.errors) && responseData.errors.length > 0) {
          const firstError = responseData.errors[0];
          message = typeof firstError === "string" ? firstError : firstError.description || "";
        }

        const status = error.response.status;
        switch (status) {
          case 400:
            throw new HueError(message || "Bad request", StatusCodes.BadRequest, error);
          case 401:
          case 403:
            throw new HueError(message || "Unauthorized", StatusCodes.Unauthorized, error);
          case 404:
            throw new HueError(message || "Not found", StatusCodes.NotFound, error);
          default:
            throw new HueError(message || `API error: ${status}`, StatusCodes.ServerError, error);
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
    if (!this.hubUrl) {
      throw new HueError("Hub URL is required", StatusCodes.ServiceUnavailable);
    }
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
    if (!this.hubUrl) {
      throw new HueError("Failed to generate auth key: Hub URL is required", StatusCodes.ServiceUnavailable);
    }
    try {
      const { data } = await this.axiosInstance.post<AuthenticateResult[]>(`/api`, {
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

  /**
   * Sends an HTTP request to the Philips Hue API with support for retries on certain error statuses.
   *
   * @param method - The HTTP method to use for the request.
   * @param endpoint - The API endpoint to be called.
   * @param [body] - The optional body payload for the request (for POST or PUT methods).
   * @param [authRequired=true] - Indicates whether the request requires authentication.
   * @return A promise that resolves to the parsed response data of type `T` if the request is successful.
   * @throws {HueError} Throws an error if authentication fails, the API returns an error, or retries are exhausted.
   */
  async sendRequest<T>(
    method: "GET" | "POST" | "PUT",
    endpoint: string,
    body?: unknown,
    authRequired: boolean = true
  ): Promise<T> {
    log.msgTrace("Philips Hue API request: %s %s", method, endpoint);
    if (authRequired && !this.axiosInstance.defaults.headers.common["hue-application-key"]) {
      throw new HueError("auth key is required in protected resource", StatusCodes.Unauthorized);
    }

    // The bridge will deny more than 3 requests at the same time with a 429 error.
    // The Python aiohue library also mentions 503 if the hub is overloaded.
    // These error codes are automatically retried.
    let retries = 0;
    let statusCode = 0;
    while (retries < MAX_RETRIES) {
      retries++;

      if (retries > 1) {
        const retryWaitMs = 250 * (retries - 1);
        log.debug("Got %d error from Hue bridge, retry request #%d in %d ms", statusCode, retries, retryWaitMs);
        await delay(retryWaitMs);
      }

      try {
        const { data } = await this.axiosInstance.request<T>({
          method,
          url: endpoint,
          data: body
        });

        // Check for V2 API errors in the response body (even if status is 2xx)
        if (
          data &&
          typeof data === "object" &&
          !Array.isArray(data) &&
          "errors" in data &&
          Array.isArray(data.errors) &&
          data.errors.length > 0
        ) {
          const firstError = data.errors[0];
          const message = typeof firstError === "string" ? firstError : firstError.description || "Unknown API error";
          throw new HueError(message, StatusCodes.ServerError);
        }

        return data;
      } catch (error: unknown) {
        if (axios.isAxiosError(error) && error.response) {
          statusCode = error.response.status;
          // Retry on 429 (Rate Limit) or 503 (Service Unavailable)
          if ((statusCode === 429 || statusCode === 503) && retries < MAX_RETRIES) {
            continue;
          }
        }

        if (error instanceof HueError) {
          throw error;
        }
        this.handleError(error, method, endpoint);
      }
    }

    throw new HueError(
      `${retries} requests to the bridge failed, it is probably overloaded. Giving up.`,
      StatusCodes.ServiceUnavailable
    );
  }

  /**
   * Check if there is a bridge alive on given ip and return bridge ID.
   *
   * @returns The bridge ID.
   * @throws {HueError} If the bridge cannot be reached or returns an invalid response.
   */
  async is_hue_bridge(): Promise<string> {
    if (!this.hubUrl) {
      throw new HueError("Hub URL is required", StatusCodes.ServiceUnavailable);
    }
    // every hue bridge returns discovery info on this endpoint
    const hubHttp = this.hubUrl.replace("https://", "http://");
    const endpoint = `${hubHttp}/api/config`;
    try {
      const data = await this.sendRequest<HubConfig>("GET", endpoint, undefined, false);
      if (!data.bridgeid) {
        throw new HueError("Invalid API response, not a real Hue bridge?", StatusCodes.ServiceUnavailable);
      }
      return normalizeBridgeId(data.bridgeid);
    } catch (error) {
      if (error instanceof HueError) {
        throw error;
      }
      throw new HueError("Failed to check if it is a Hue bridge", StatusCodes.ServiceUnavailable, error);
    }
  }

  /**
   * Check if the bridge has support for the new V2 api.
   *
   * @returns True if the bridge supports V2 API, false otherwise.
   */
  async is_v2_bridge(): Promise<boolean> {
    if (!this.hubUrl) {
      return false;
    }
    try {
      // v2 api is https only and returns a 403 forbidden when no key provided
      await this.sendRequest("GET", "/clip/v2/resource", undefined, false);
      return false;
    } catch (error) {
      // all other status/exceptions means the bridge is not v2 or not reachable at this time
      if (error instanceof HueError && error.statusCode === StatusCodes.Unauthorized) {
        if (axios.isAxiosError(error.cause) && error.cause.response?.status === 403) {
          return true;
        }
      }
      return false;
    }
  }
}

export default HueApi;
