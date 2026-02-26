/**
 * Stomp Local Agent - Content Script
 *
 * Bridges between the web page (postMessage) and the extension
 * background service worker (chrome.runtime port).
 *
 * The content script runs in the same page context as the web app,
 * but has access to chrome.runtime APIs that the web app doesn't.
 */

const ALLOWED_ORIGIN = "https://stomp-template-send-sigma.vercel.app";

// Map of connectionId → port for managing multiple simultaneous connections
const connections = new Map();

// Listen for messages from the web page
window.addEventListener("message", (event) => {
  // Security: only accept messages from our own window and allowed origin
  if (event.source !== window) return;
  if (event.origin !== ALLOWED_ORIGIN) return;

  const { type, connectionId } = event.data || {};

  if (!type || !connectionId) return;

  switch (type) {
    case "AGENT_PING": {
      // Simple ping to detect extension presence
      try {
        const port = chrome.runtime.connect({ name: "stomp-local-agent" });
        port.postMessage({ type: "PING" });
        port.onMessage.addListener((msg) => {
          if (msg.type === "PONG") {
            window.postMessage(
              {
                type: "AGENT_PONG",
                connectionId,
              },
              event.origin
            );
            port.disconnect();
          }
        });
        // Timeout cleanup
        setTimeout(() => {
          try { port.disconnect(); } catch {}
        }, 2000);
      } catch {
        // Extension not available
      }
      break;
    }

    case "WS_OPEN": {
      // Create a new persistent port for this WebSocket connection
      const port = chrome.runtime.connect({ name: "stomp-local-agent" });
      connections.set(connectionId, port);

      // Relay all messages from background → web page
      port.onMessage.addListener((msg) => {
        window.postMessage(
          {
            ...msg,
            connectionId,
          },
          event.origin
        );
      });

      // Cleanup on disconnect
      port.onDisconnect.addListener(() => {
        connections.delete(connectionId);
        window.postMessage(
          {
            type: "WS_EVENT_CLOSE",
            connectionId,
            code: 1006,
            reason: "Extension port disconnected",
            wasClean: false,
          },
          event.origin
        );
      });

      // Forward the open request
      port.postMessage({ type: "WS_OPEN", url: event.data.url });
      break;
    }

    case "WS_SEND": {
      const port = connections.get(connectionId);
      if (port) {
        port.postMessage({ type: "WS_SEND", data: event.data.data });
      }
      break;
    }

    case "WS_CLOSE": {
      const port = connections.get(connectionId);
      if (port) {
        port.postMessage({
          type: "WS_CLOSE",
          code: event.data.code,
          reason: event.data.reason,
        });
        // Don't delete yet - wait for WS_EVENT_CLOSE from background
      }
      break;
    }

    case "HTTP_REQUEST": {
      // For SockJS HTTP transport negotiation
      const port = connections.get(connectionId);
      if (port) {
        port.postMessage({
          type: "HTTP_REQUEST",
          url: event.data.url,
          method: event.data.method,
          headers: event.data.headers,
          body: event.data.body,
          requestId: event.data.requestId,
        });
      }
      break;
    }
  }
});

// Inject a marker to let the page know the content script is loaded
function injectMarker() {
  const marker = document.createElement("meta");
  marker.name = "stomp-local-agent";
  marker.content = "installed";
  if (document.head) {
    document.head.appendChild(marker);
  } else {
    // document.head doesn't exist yet at document_start, wait for it
    const observer = new MutationObserver(() => {
      if (document.head) {
        document.head.appendChild(marker);
        observer.disconnect();
      }
    });
    observer.observe(document.documentElement || document, {
      childList: true,
      subtree: true,
    });
  }
}
injectMarker();
