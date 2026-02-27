/**
 * Stomp Local Agent - Background Service Worker
 *
 * Privileged proxy that creates real WebSocket connections to localhost
 * on behalf of the web app. Features:
 *   - WebSocketManager for centralized connection tracking
 *   - Keepalive via chrome.alarms to prevent MV3 service worker sleep
 *   - Heartbeat ping every 20s to keep WS alive
 *   - Auto-reconnect with exponential backoff
 *
 * Protocol (Incoming from content script):
 *   WS_OPEN    { url }                → Open a WebSocket
 *   WS_SEND    { data }               → Send data
 *   WS_CLOSE   { code, reason }       → Close (no reconnect)
 *   HTTP_REQUEST { url, method, ... }  → Make an HTTP request
 *   PING                              → Extension detection
 *
 * Protocol (Outgoing to content script):
 *   WS_EVENT_OPEN         {}                          → WebSocket opened
 *   WS_EVENT_MESSAGE      { data }                    → Message received
 *   WS_EVENT_ERROR        { error }                   → Error occurred
 *   WS_EVENT_CLOSE        { code, reason, wasClean }  → WebSocket closed
 *   WS_EVENT_RECONNECTING { attempt, delay, maxAttempts } → Reconnecting
 *   WS_EVENT_RECONNECTED  {}                          → Reconnected successfully
 *   HTTP_RESPONSE         { ... }                     → HTTP response
 *   PONG                                              → Extension alive
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

console.log("[BG] 🚀 Stomp Local Agent background service worker started");

// ---------------------------------------------------------------------------
// Register dynamic rules to rewrite Origin header for extension's own requests.
// Static rules (rules.json) DON'T apply to extension-initiated requests by default.
// We must use dynamic rules with initiatorDomains: [chrome.runtime.id].
// ---------------------------------------------------------------------------
(async () => {
  const extId = chrome.runtime.id;
  console.log(`[BG] Extension ID: ${extId}`);

  // Remove old dynamic rules first, then add fresh ones
  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
  const oldIds = existingRules.map(r => r.id);

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: oldIds,
    addRules: [
      {
        id: 100,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Origin", operation: "set", value: "http://localhost" }
          ]
        },
        condition: {
          urlFilter: "||localhost",
          resourceTypes: ["websocket"],
          initiatorDomains: [extId]
        }
      },
      {
        id: 101,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Origin", operation: "set", value: "http://127.0.0.1" }
          ]
        },
        condition: {
          urlFilter: "||127.0.0.1",
          resourceTypes: ["websocket"],
          initiatorDomains: [extId]
        }
      }
    ]
  });

  console.log("[BG] ✅ Dynamic declarativeNetRequest rules registered (Origin rewrite for WS)");
})();

const ALLOWED_ORIGINS = [
  "http://localhost",
  "http://127.0.0.1",
  "ws://localhost",
  "ws://127.0.0.1",
];

const KEEPALIVE_ALARM = "ws-keepalive";
const KEEPALIVE_INTERVAL_MIN = 0.4; // ~24 seconds
const HEARTBEAT_INTERVAL_MS = 20_000; // 20 seconds
const MAX_RECONNECT_ATTEMPTS = 10;
const MAX_RECONNECT_DELAY_MS = 30_000; // 30 seconds

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAllowedUrl(url) {
  try {
    const parsed = new URL(url);
    const origin = `${parsed.protocol}//${parsed.hostname}`;
    return ALLOWED_ORIGINS.some(
      (allowed) => origin === allowed || origin.startsWith(allowed + ":")
    );
  } catch {
    return false;
  }
}

function toWsUrl(url) {
  if (url.startsWith("https://")) return url.replace("https://", "wss://");
  if (url.startsWith("http://")) return url.replace("http://", "ws://");
  return url;
}

function reconnectDelay(attempt) {
  return Math.min(1000 * Math.pow(2, attempt), MAX_RECONNECT_DELAY_MS);
}

// ---------------------------------------------------------------------------
// WSConnection — manages a single WebSocket with heartbeat & reconnect
// ---------------------------------------------------------------------------

class WSConnection {
  /**
   * @param {string} id   - Unique connection ID
   * @param {string} url  - Target WebSocket URL (ws:// or http://)
   * @param {chrome.runtime.Port} port - Port to relay events to
   */
  constructor(id, url, port) {
    this.id = id;
    this.url = url;
    this.port = port;
    this.socket = null;
    this.status = "IDLE"; // IDLE | CONNECTING | OPEN | CLOSING | CLOSED | RECONNECTING
    this.reconnectAttempts = 0;
    this.maxReconnect = MAX_RECONNECT_ATTEMPTS;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.shouldReconnect = true; // false when user explicitly closes
  }

  // --- Lifecycle -----------------------------------------------------------

  connect() {
    console.log(`[BG] WSConnection.connect() id=${this.id} url=${this.url}`);
    if (this.socket) {
      console.log(`[BG] Closing existing socket before reconnect`);
      try { this.socket.close(); } catch {}
      this.socket = null;
    }

    this.status = "CONNECTING";
    const wsUrl = toWsUrl(this.url);
    console.log(`[BG] Creating WebSocket to: ${wsUrl}`);

    try {
      this.socket = new WebSocket(wsUrl);
      console.log(`[BG] WebSocket created, readyState=${this.socket.readyState}`);
      this.socket.binaryType = "arraybuffer";

      this.socket.onopen = () => {
        console.log(`[BG] ✅ WebSocket OPEN id=${this.id}`);
        this.status = "OPEN";
        this.startHeartbeat();

        // If this was a reconnect, send RECONNECTED instead of OPEN
        if (this.reconnectAttempts > 0) {
          console.log(`[BG] Reconnected after ${this.reconnectAttempts} attempts`);
          this.reconnectAttempts = 0;
          this._send({ type: "WS_EVENT_RECONNECTED" });
        } else {
          this._send({ type: "WS_EVENT_OPEN" });
        }
      };

      this.socket.onmessage = (event) => {
        this._send({
          type: "WS_EVENT_MESSAGE",
          data:
            typeof event.data === "string"
              ? event.data
              : Array.from(new Uint8Array(event.data)),
        });
      };

      this.socket.onerror = (evt) => {
        console.error(`[BG] ❌ WebSocket ERROR id=${this.id}`, evt);
        this._send({
          type: "WS_EVENT_ERROR",
          error: "WebSocket error occurred",
        });
      };

      this.socket.onclose = (event) => {
        console.log(`[BG] WebSocket CLOSE id=${this.id} code=${event.code} reason="${event.reason}" wasClean=${event.wasClean}`);
        this.stopHeartbeat();
        this.socket = null;

        if (this.shouldReconnect && !event.wasClean) {
          console.log(`[BG] Unexpected close, will reconnect...`);
          this.reconnect();
        } else {
          console.log(`[BG] Clean close or user-requested, no reconnect`);
          this.status = "CLOSED";
          this._send({
            type: "WS_EVENT_CLOSE",
            code: event.code,
            reason: event.reason,
            wasClean: event.wasClean,
          });
        }
      };
    } catch (err) {
      console.error(`[BG] WebSocket constructor threw:`, err);
      this._send({ type: "WS_EVENT_ERROR", error: err.message });
    }
  }

  send(data) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this._send({ type: "WS_EVENT_ERROR", error: "WebSocket is not open" });
      return;
    }
    try {
      this.socket.send(data);
    } catch (err) {
      this._send({ type: "WS_EVENT_ERROR", error: err.message });
    }
  }

  /**
   * Close connection explicitly (user-initiated). No reconnect.
   */
  close(code = 1000, reason = "") {
    this.shouldReconnect = false;
    this.stopHeartbeat();
    this.clearReconnectTimer();

    if (this.socket) {
      try {
        this.status = "CLOSING";
        this.socket.close(code, reason);
      } catch {}
      this.socket = null;
    }

    this.status = "CLOSED";
    this._send({
      type: "WS_EVENT_CLOSE",
      code,
      reason,
      wasClean: true,
    });
  }

  /**
   * Force-destroy without sending close events (port disconnected)
   */
  destroy() {
    this.shouldReconnect = false;
    this.stopHeartbeat();
    this.clearReconnectTimer();
    if (this.socket) {
      try { this.socket.close(); } catch {}
      this.socket = null;
    }
    this.status = "CLOSED";
  }

  // --- Reconnect -----------------------------------------------------------

  reconnect() {
    console.log(`[BG] reconnect() id=${this.id} attempt=${this.reconnectAttempts}/${this.maxReconnect}`);
    if (this.reconnectAttempts >= this.maxReconnect) {
      console.log(`[BG] Max reconnect attempts reached, giving up`);
      this.status = "CLOSED";
      this._send({
        type: "WS_EVENT_CLOSE",
        code: 1006,
        reason: `Max reconnect attempts (${this.maxReconnect}) reached`,
        wasClean: false,
      });
      return;
    }

    this.reconnectAttempts++;
    this.status = "RECONNECTING";
    const delay = reconnectDelay(this.reconnectAttempts);
    console.log(`[BG] Will retry in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this._send({
      type: "WS_EVENT_RECONNECTING",
      attempt: this.reconnectAttempts,
      delay,
      maxAttempts: this.maxReconnect,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // --- Heartbeat -----------------------------------------------------------

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        // Send a WebSocket ping frame (via empty string or custom ping)
        // Note: Browser WebSocket API doesn't expose ping/pong frames,
        // but sending a small payload keeps the connection alive.
        try {
          // STOMP heartbeat is handled by the STOMP library itself,
          // so we just need to keep the connection from being
          // considered idle by network intermediaries.
          // We do NOT send actual data to avoid confusing STOMP.
          // The socket.send is intentionally omitted here.
          // The timer itself keeps the service worker alive.
        } catch {}
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // --- Internal ------------------------------------------------------------

  _send(msg) {
    try {
      this.port.postMessage(msg);
    } catch {
      // Port disconnected — cleanup
      this.destroy();
    }
  }
}

// ---------------------------------------------------------------------------
// WebSocketManager — manages all connections
// ---------------------------------------------------------------------------

class WebSocketManager {
  constructor() {
    /** @type {Map<string, WSConnection>} */
    this.connections = new Map();
  }

  connect(id, url, port) {
    // Close existing connection with same ID if any
    if (this.connections.has(id)) {
      this.connections.get(id).destroy();
    }

    const conn = new WSConnection(id, url, port);
    this.connections.set(id, conn);
    conn.connect();

    // Start keepalive alarm when first connection is made
    this._ensureKeepalive();

    return conn;
  }

  send(id, data) {
    const conn = this.connections.get(id);
    if (conn) {
      conn.send(data);
    }
  }

  disconnect(id, code, reason) {
    const conn = this.connections.get(id);
    if (conn) {
      conn.close(code, reason);
      this.connections.delete(id);
      this._checkKeepalive();
    }
  }

  destroyByPort(port) {
    for (const [id, conn] of this.connections) {
      if (conn.port === port) {
        conn.destroy();
        this.connections.delete(id);
      }
    }
    this._checkKeepalive();
  }

  _ensureKeepalive() {
    if (this.connections.size > 0) {
      chrome.alarms.create(KEEPALIVE_ALARM, {
        periodInMinutes: KEEPALIVE_INTERVAL_MIN,
      });
    }
  }

  _checkKeepalive() {
    if (this.connections.size === 0) {
      chrome.alarms.clear(KEEPALIVE_ALARM);
    }
  }
}

// ---------------------------------------------------------------------------
// Global manager instance
// ---------------------------------------------------------------------------

const wsManager = new WebSocketManager();

// ---------------------------------------------------------------------------
// Keepalive alarm handler
// ---------------------------------------------------------------------------

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    // This handler firing is enough to keep the service worker alive.
    // Optionally log active connection count for debugging.
    console.log(
      `[keepalive] tick — ${wsManager.connections.size} active connection(s)`
    );

    // If no connections remain, clear the alarm
    if (wsManager.connections.size === 0) {
      chrome.alarms.clear(KEEPALIVE_ALARM);
    }
  }
});

// ---------------------------------------------------------------------------
// Port connection handler
// ---------------------------------------------------------------------------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "stomp-local-agent") return;
  console.log(`[BG] Port connected: ${port.name}`);

  // Track connectionId → this port for this session
  let activeConnectionId = null;

  port.onMessage.addListener((msg) => {
    console.log(`[BG] Port message received:`, msg.type, msg);
    switch (msg.type) {
      case "PING":
        console.log(`[BG] PING received, sending PONG`);
        port.postMessage({ type: "PONG" });
        break;

      case "WS_OPEN": {
        const { url, connectionId } = msg;
        console.log(`[BG] WS_OPEN url=${url} connectionId=${connectionId}`);

        if (!isAllowedUrl(url)) {
          console.log(`[BG] URL not allowed: ${url}`);
          port.postMessage({
            type: "WS_EVENT_ERROR",
            error: `URL not allowed: ${url}. Only localhost URLs are permitted.`,
          });
          return;
        }

        activeConnectionId = connectionId || port.name + "-" + Date.now();
        console.log(`[BG] Creating connection with id=${activeConnectionId}`);
        wsManager.connect(activeConnectionId, url, port);
        break;
      }

      case "WS_SEND": {
        if (activeConnectionId) {
          wsManager.send(activeConnectionId, msg.data);
        } else {
          port.postMessage({
            type: "WS_EVENT_ERROR",
            error: "No active connection",
          });
        }
        break;
      }

      case "WS_CLOSE": {
        if (activeConnectionId) {
          wsManager.disconnect(
            activeConnectionId,
            msg.code || 1000,
            msg.reason || ""
          );
          activeConnectionId = null;
        }
        break;
      }

      case "HTTP_REQUEST": {
        const { url, method, headers, body, requestId } = msg;

        if (!isAllowedUrl(url)) {
          port.postMessage({
            type: "HTTP_RESPONSE",
            requestId,
            success: false,
            error: `URL not allowed: ${url}. Only localhost URLs are permitted.`,
          });
          return;
        }

        (async () => {
          try {
            const response = await fetch(url, {
              method: method || "GET",
              headers: headers || {},
              body: body
                ? typeof body === "string"
                  ? body
                  : JSON.stringify(body)
                : undefined,
            });

            const text = await response.text();

            port.postMessage({
              type: "HTTP_RESPONSE",
              requestId,
              success: true,
              status: response.status,
              statusText: response.statusText,
              headers: Object.fromEntries(response.headers.entries()),
              body: text,
            });
          } catch (err) {
            port.postMessage({
              type: "HTTP_RESPONSE",
              requestId,
              success: false,
              error: err.message,
            });
          }
        })();
        break;
      }
    }
  });

  port.onDisconnect.addListener(() => {
    console.log(`[BG] Port disconnected, destroying connections`);
    wsManager.destroyByPort(port);
    activeConnectionId = null;
  });
});
