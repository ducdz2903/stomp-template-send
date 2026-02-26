/**
 * AgentWebSocket - Custom WebSocket implementation that proxies through
 * the Stomp Local Agent Chrome extension.
 *
 * This class implements the same interface as the native WebSocket,
 * allowing @stomp/stompjs and SockJS to use it transparently.
 * Instead of connecting directly to localhost (which browsers block
 * from public origins), it routes traffic through the extension's
 * privileged background service worker.
 */

type WebSocketEventHandler = ((this: WebSocket, ev: Event) => void) | null;
type MessageEventHandler = ((this: WebSocket, ev: MessageEvent) => void) | null;
type CloseEventHandler = ((this: WebSocket, ev: CloseEvent) => void) | null;

export class AgentWebSocket {
  // WebSocket interface properties
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState: number = 0; // CONNECTING
  url: string;
  protocol: string = '';
  extensions: string = '';
  bufferedAmount: number = 0;
  binaryType: BinaryType = 'blob';

  // Event handlers
  onopen: WebSocketEventHandler = null;
  onmessage: MessageEventHandler = null;
  onerror: WebSocketEventHandler = null;
  onclose: CloseEventHandler = null;

  // Internal
  private connectionId: string;
  private messageHandler: ((event: MessageEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    this.connectionId = crypto.randomUUID();
    this.readyState = this.CONNECTING;

    // Listen for responses from extension via content script
    this.messageHandler = (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.connectionId !== this.connectionId) return;

      switch (data.type) {
        case 'WS_EVENT_OPEN':
          this.readyState = this.OPEN;
          if (this.onopen) {
            this.onopen.call(this as unknown as WebSocket, new Event('open'));
          }
          break;

        case 'WS_EVENT_MESSAGE':
          if (this.onmessage) {
            const msgEvent = new MessageEvent('message', {
              data: data.data,
            });
            this.onmessage.call(this as unknown as WebSocket, msgEvent);
          }
          break;

        case 'WS_EVENT_ERROR':
          if (this.onerror) {
            this.onerror.call(this as unknown as WebSocket, new Event('error'));
          }
          break;

        case 'WS_EVENT_CLOSE':
          this.readyState = this.CLOSED;
          this.cleanup();
          if (this.onclose) {
            const closeEvent = new CloseEvent('close', {
              code: data.code || 1000,
              reason: data.reason || '',
              wasClean: data.wasClean ?? true,
            });
            this.onclose.call(this as unknown as WebSocket, closeEvent);
          }
          break;
      }
    };

    window.addEventListener('message', this.messageHandler);

    // Send open request to extension
    window.postMessage(
      {
        type: 'WS_OPEN',
        connectionId: this.connectionId,
        url: url,
      },
      window.location.origin
    );
  }

  send(data: string | ArrayBuffer | Blob): void {
    if (this.readyState !== this.OPEN) {
      throw new DOMException(
        "Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.",
        'InvalidStateError'
      );
    }

    window.postMessage(
      {
        type: 'WS_SEND',
        connectionId: this.connectionId,
        data: data,
      },
      window.location.origin
    );
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === this.CLOSED || this.readyState === this.CLOSING) {
      return;
    }

    this.readyState = this.CLOSING;

    window.postMessage(
      {
        type: 'WS_CLOSE',
        connectionId: this.connectionId,
        code: code || 1000,
        reason: reason || '',
      },
      window.location.origin
    );
  }

  private cleanup(): void {
    if (this.messageHandler) {
      window.removeEventListener('message', this.messageHandler);
      this.messageHandler = null;
    }
  }

  // EventTarget interface stubs (required by some libraries)
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    // Map addEventListener to the on* properties for simplicity
    switch (type) {
      case 'open':
        this.onopen = listener as WebSocketEventHandler;
        break;
      case 'message':
        this.onmessage = listener as MessageEventHandler;
        break;
      case 'error':
        this.onerror = listener as WebSocketEventHandler;
        break;
      case 'close':
        this.onclose = listener as CloseEventHandler;
        break;
    }
  }

  removeEventListener(type: string, _listener: EventListenerOrEventListenerObject): void {
    switch (type) {
      case 'open':
        this.onopen = null;
        break;
      case 'message':
        this.onmessage = null;
        break;
      case 'error':
        this.onerror = null;
        break;
      case 'close':
        this.onclose = null;
        break;
    }
  }

  dispatchEvent(_event: Event): boolean {
    return false;
  }
}
