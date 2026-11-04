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
    // Telegram puts its launch parameters in the address's fragment. A Mini App opened from a keyboard
    // button (the setup page) gets no user data, so tgWebAppData may be missing; the others are there.
    if (/(^#|&)tgWebApp(Data|Version|Platform)=/.test(location.hash)) {
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

/** The Bot API version of the Telegram app the page runs in ("8.0"), from its launch parameters; null outside Telegram. */
export function telegramVersion(): string | null {
  try {
    const params = new URLSearchParams(location.hash.includes("tgWebAppVersion=") ? location.hash.slice(1) : (sessionStorage.getItem("__telegram__initParams") ?? ""));
    const version = params.get("tgWebAppVersion");
    return version && /^\d+(\.\d+)*$/.test(version) ? version : null;
  } catch {
    return null;
  }
}

/** Whether `version` ("7.10") is at least `min` ("7.0"). */
export function versionAtLeast(version: string, min: string): boolean {
  const a = version.split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** Whether the page runs as a Telegram Mini App (opened from one of the bot's buttons). */
export function inTelegram(): boolean {
  return typeof window !== "undefined" && launchedFromTelegram();
}

/**
 * Whether the page runs inside a Telegram app, with its bridge: not merely a browser whose address carries
 * Telegram's launch data (anyone can paste that into a link). The setup page needs this: only there does
 * its result reach the bot, from the user who opened it.
 */
export function inTelegramClient(): boolean {
  if (!inTelegram()) return false;
  const bridge = window as unknown as Bridge;
  return !!bridge.TelegramWebviewProxy || typeof bridge.external?.notify === "function" || window.parent !== window;
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

/**
 * Sends `data` (4096 bytes at most) to the bot as a message from this user, and closes the Mini App.
 * Telegram does it only for a Mini App opened from a keyboard button (the bot's "Set up GetLeash");
 * anywhere else nothing happens, so the page keeps showing what to do instead.
 * https://core.telegram.org/api/web-events#web-app-data-send
 */
export function sendDataToBot(data: string): void {
  if (inTelegram()) postEvent("web_app_data_send", { data });
}

export function startTelegramMiniApp(): void {
  if (typeof window === "undefined" || !launchedFromTelegram()) return;
  postEvent("web_app_ready");
  postEvent("web_app_expand");
}
