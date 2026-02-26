/**
 * Local Agent Utilities
 *
 * Helper functions for detecting the Stomp Local Agent Chrome extension
 * and determining when to use it.
 */

/**
 * Check if the Stomp Local Agent extension is installed and responsive.
 * Sends a ping via postMessage and waits for a pong response.
 */
export function isLocalAgentAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const connectionId = crypto.randomUUID();
    let resolved = false;

    function handler(event: MessageEvent) {
      if (event.source !== window) return;
      if (
        event.data?.type === 'AGENT_PONG' &&
        event.data?.connectionId === connectionId
      ) {
        resolved = true;
        window.removeEventListener('message', handler);
        resolve(true);
      }
    }

    window.addEventListener('message', handler);

    window.postMessage(
      {
        type: 'AGENT_PING',
        connectionId,
      },
      window.location.origin
    );

    // Timeout after 2 seconds (content script may need time to initialize)
    setTimeout(() => {
      if (!resolved) {
        window.removeEventListener('message', handler);
        resolve(false);
      }
    }, 2000);
  });
}

/**
 * Check if a URL points to localhost or 127.0.0.1
 */
export function isLocalhostUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
    );
  } catch {
    return false;
  }
}

/**
 * Check if the app is currently running on localhost
 */
export function isRunningOnLocalhost(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1'
  );
}

/**
 * Determine if the agent should be used for a given URL.
 * Agent is needed when:
 * 1. The target URL is localhost
 * 2. The app is NOT running on localhost (i.e., deployed to Vercel)
 */
export function shouldUseAgent(url: string): boolean {
  return isLocalhostUrl(url) && !isRunningOnLocalhost();
}
