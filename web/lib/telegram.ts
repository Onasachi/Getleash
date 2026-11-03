"use client";

/**
 * Inside a Telegram Mini App (the bot's "Review and approve" button opens the payment page there):
 * tell Telegram the page is ready, use the full height, and keep Telegram's launch parameters for the
 * session, so the wallet connector (near-connect, which routes wallets such as HOT Wallet through
 * Telegram) still knows it runs in Telegram after the first page. Uses Telegram's raw bridge, like
 * near-connect itself, instead of loading a script from telegram.org: https://core.telegram.org/api/web-events
 */
type Bridge = {
  TelegramWebviewProxy?: { postEvent(eventType: string, eventData: string): void };
  external?: { notify?: (message: string) => void };
};

function launchedFromTelegram(): boolean {
  try {
    if (location.hash.includes("tgWebAppData")) {
      // The key Telegram's own script uses, which near-connect checks.
      sessionStorage.setItem("__telegram__initParams", location.hash.slice(1));
      return true;
    }
    return !!sessionStorage.getItem("__telegram__initParams") || !!(window as unknown as Bridge).TelegramWebviewProxy;
  } catch {
    return false;
  }
}

function postEvent(eventType: string, eventData: object = {}) {
  const bridge = window as unknown as Bridge;
  if (bridge.TelegramWebviewProxy?.postEvent) return bridge.TelegramWebviewProxy.postEvent(eventType, JSON.stringify(eventData)); // iOS, Android
  if (typeof bridge.external?.notify === "function") return bridge.external.notify(JSON.stringify({ eventType, eventData })); // Desktop
  if (window.parent !== window) window.parent.postMessage(JSON.stringify({ eventType, eventData }), "https://web.telegram.org"); // Web
}

export function startTelegramMiniApp(): void {
  if (typeof window === "undefined" || !launchedFromTelegram()) return;
  postEvent("web_app_ready");
  postEvent("web_app_expand");
}
