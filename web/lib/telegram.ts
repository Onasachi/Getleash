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

/** Whether the page runs as a Telegram Mini App (opened from one of the bot's buttons). */
export function inTelegram(): boolean {
  return typeof window !== "undefined" && launchedFromTelegram();
}

/** Opens a t.me link (such as HOT Wallet's Mini App) through Telegram, which a Mini App has to ask for; outside Telegram, in a new tab. */
export function openTelegramLink(url: string): void {
  if (!inTelegram()) {
    window.open(url, "_blank", "noopener");
    return;
  }
  const { pathname, search } = new URL(url);
  postEvent("web_app_open_tg_link", { path_full: pathname + search });
}

/** Closes the Mini App, back to the chat (inside Telegram only). */
export function closeMiniApp(): void {
  if (inTelegram()) postEvent("web_app_close");
}

export function startTelegramMiniApp(): void {
  if (typeof window === "undefined" || !launchedFromTelegram()) return;
  postEvent("web_app_ready");
  postEvent("web_app_expand");
}
