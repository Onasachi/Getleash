/**
 * The wallet that runs inside Telegram. near-connect's manifest (hot-dao/near-selector, checked
 * 2026-11-03) lists HOT Wallet as the only wallet with a Telegram Mini App (`platform.tga`), so the bot's
 * /wallet points owners there and the dashboard connects to it directly when it runs inside Telegram.
 */
export const HOT_WALLET_ID = "hot-wallet";
export const HOT_WALLET_TELEGRAM = "https://t.me/hot_wallet/app";
