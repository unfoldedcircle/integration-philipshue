/**
 * Philips Hue API for the Remote Two/3 integration driver.
 *
 * @copyright (c) 2024 by Unfolded Circle ApS.
 * @license Mozilla Public License Version 2.0, see LICENSE for more details.
 */

import { EventSource } from "eventsource";
import EventEmitter from "node:events";
import { Agent, fetch } from "undici";
import log from "../../log.js";
import { HueEvent } from "./types.js";

class HueEventStream extends EventEmitter {
  private es: EventSource | null = null;
  private reconnectInterval = 1000;
  private connected = false;

  constructor() {
    super();
  }

  connect(hubUrl: string, authKey: string) {
    if (this.connected) {
      return;
    }
    const dispatcher = new Agent({
      connect: {
        rejectUnauthorized: false,
        checkServerIdentity: () => {
          return undefined;
        }
      }
    });
    const headers = {
      Accept: "text/event-stream",
      "hue-application-key": authKey
    };

    this.es = new EventSource(hubUrl + "/eventstream/clip/v2", {
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          dispatcher,
          headers: {
            ...init?.headers,
            ...headers
          }
        })
    });

    this.es.onopen = () => {
      this.connected = true;
      this.emit("connected");
    };

    this.es.onopen = () => {
      log.debug("Philips Hue event stream connected");
      this.connected = true;
      this.emit("connected");
    };
    this.es.onmessage = (event) => {
      try {
        const messages = JSON.parse(event.data) as HueEvent[];
        for (const message of messages) {
          this.emit(message.type, message);
        }
      } catch (err) {
        this.emit("error", err);
      }
    };

    this.es.onerror = (err) => {
      log.debug("Philips Hue event stream error", err);
      this.connected = false;
      this.emit("disconnected");
    };
  }

  disconnect() {
    if (this.es) {
      this.es.close();
      this.connected = false;
      this.emit("disconnected");
    }
  }
}

export default HueEventStream;
