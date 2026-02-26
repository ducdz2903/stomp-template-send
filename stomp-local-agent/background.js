/**
 * Stomp Local Agent - Background Service Worker
 *
 * This is the privileged proxy that creates real WebSocket connections
 * to localhost on behalf of the web app. It communicates with the
 * content script via chrome.runtime ports.
 *
 * Protocol:
 *   WS_OPEN    { url }           → Open a WebSocket to the given URL
 *   WS_SEND    { data }          → Send data through the WebSocket
 *   WS_CLOSE   { code, reason }  → Close the WebSocket
 *   HTTP_REQUEST { url, method, headers, body } → Make an HTTP request
 *
 *   WS_EVENT_OPEN    {}                     → WebSocket opened
 *   WS_EVENT_MESSAGE { data }               → WebSocket message received
 *   WS_EVENT_ERROR   { error }              → WebSocket error
 *   WS_EVENT_CLOSE   { code, reason, wasClean } → WebSocket closed
 *   HTTP_RESPONSE    { success, status, headers, body, error } → HTTP response
 *
 *   PING / PONG → Extension detection
 */

const ALLOWED_ORIGINS = [
  "http://localhost",
  "http://127.0.0.1",
  "ws://localhost",
  "ws://127.0.0.1",
];

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

// Convert http(s) URL to ws(s) URL for WebSocket connections
function toWsUrl(url) {
  if (url.startsWith("https://")) return url.replace("https://", "wss://");
  if (url.startsWith("http://")) return url.replace("http://", "ws://");
  return url;
}

// Handle persistent port connections for WebSocket relay
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "stomp-local-agent") return;

  let ws = null;

  port.onMessage.addListener((msg) => {
    switch (msg.type) {
      case "PING":
        port.postMessage({ type: "PONG" });
        break;

      case "WS_OPEN": {
        const { url } = msg;

        if (!isAllowedUrl(url)) {
          port.postMessage({
            type: "WS_EVENT_ERROR",
            error: `URL not allowed: ${url}. Only localhost URLs are permitted.`,
          });
          return;
        }

        // Close existing connection if any
        if (ws) {
          try {
            ws.close();
          } catch {}
          ws = null;
        }

        const wsUrl = toWsUrl(url);

        try {
          ws = new WebSocket(wsUrl);
          ws.binaryType = "arraybuffer";

          ws.onopen = () => {
            port.postMessage({ type: "WS_EVENT_OPEN" });
          };

          ws.onmessage = (event) => {
            port.postMessage({
              type: "WS_EVENT_MESSAGE",
              data:
                typeof event.data === "string"
                  ? event.data
                  : Array.from(new Uint8Array(event.data)),
            });
          };

          ws.onerror = (event) => {
            port.postMessage({
              type: "WS_EVENT_ERROR",
              error: "WebSocket error occurred",
            });
          };

          ws.onclose = (event) => {
            port.postMessage({
              type: "WS_EVENT_CLOSE",
              code: event.code,
              reason: event.reason,
              wasClean: event.wasClean,
            });
            ws = null;
          };
        } catch (err) {
          port.postMessage({
            type: "WS_EVENT_ERROR",
            error: err.message,
          });
        }
        break;
      }

      case "WS_SEND": {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          port.postMessage({
            type: "WS_EVENT_ERROR",
            error: "WebSocket is not open",
          });
          return;
        }
        try {
          ws.send(msg.data);
        } catch (err) {
          port.postMessage({
            type: "WS_EVENT_ERROR",
            error: err.message,
          });
        }
        break;
      }

      case "WS_CLOSE": {
        if (ws) {
          try {
            ws.close(msg.code || 1000, msg.reason || "");
          } catch {}
          ws = null;
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
              body: body ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
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
    if (ws) {
      try {
        ws.close();
      } catch {}
      ws = null;
    }
  });
});
