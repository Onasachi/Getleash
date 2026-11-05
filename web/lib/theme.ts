/**
 * Light or dark follows Telegram inside Telegram, not the phone (design system, stage 2): <html data-theme>
 * comes from the theme Telegram passes the Mini App (`tgWebAppThemeParams` in the launch fragment, then
 * `theme_changed` events, lib/telegram.ts), and is dark when its bg_color is, by the rule Telegram's own
 * script uses (https://telegram.org/js/telegram-web-app.js: brightness below 120). In a browser there is no
 * data-theme and the media query in globals.css decides. Not a client module, so the root layout can inline
 * THEME_SCRIPT, which sets the theme before the first paint.
 */

/** "dark" or "light" for a theme's bg_color ("#RRGGBB" or "#RGB"), or null when it has none. */
export function schemeOf(themeParams: unknown): "dark" | "light" | null {
  const bg = (themeParams as { bg_color?: unknown } | null)?.bg_color;
  if (typeof bg !== "string" || !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(bg)) return null;
  const hex = bg.length === 4 ? bg.replace(/[0-9a-f]/gi, (c) => c + c) : bg;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  return Math.sqrt(0.299 * r * r + 0.587 * g * g + 0.114 * b * b) < 120 ? "dark" : "light";
}

/**
 * Runs in <head> before anything renders: marks a page opened in Telegram (data-telegram) and sets its theme
 * from the launch parameters, kept in sessionStorage for later pages (lib/telegram.ts). The same rule as
 * schemeOf, written out because it runs before any bundle loads.
 */
export const THEME_SCRIPT = `(function () {
  try {
    var src = /(^#|&)tgWebApp/.test(location.hash) ? location.hash.slice(1) : sessionStorage.getItem("__telegram__initParams");
    if (!src) return;
    var root = document.documentElement;
    root.setAttribute("data-telegram", "");
    var theme = JSON.parse(new URLSearchParams(src).get("tgWebAppThemeParams") || "null");
    var bg = theme && theme.bg_color;
    if (typeof bg !== "string" || !/^#[0-9a-f]{6}$/i.test(bg)) return;
    var r = parseInt(bg.slice(1, 3), 16), g = parseInt(bg.slice(3, 5), 16), b = parseInt(bg.slice(5, 7), 16);
    root.setAttribute("data-theme", Math.sqrt(0.299 * r * r + 0.587 * g * g + 0.114 * b * b) < 120 ? "dark" : "light");
  } catch (e) {}
})();`;
