/**
 * The QR code for the bot's link, for visitors on a computer to open the bot on their phone. Made once with
 * macOS Core Image's QR generator (CIQRCodeGenerator, error correction M: a version 2 code, 25 × 25 modules)
 * and checked by scanning the rendered page with Core Image's QR detector. A page for another bot
 * (NEXT_PUBLIC_TELEGRAM_BOT) shows no code rather than a wrong one: compare its link with BOT_QR_URL first.
 */
export const BOT_QR_URL = "https://t.me/GetLeash_bot";

const BOT_QR = {
  modules: 25,
  /** The dark modules, one rectangle per run in a row. */
  d: "M0 0h7v1h-7zM9 0h1v1h-1zM12 0h3v1h-3zM18 0h7v1h-7zM0 1h1v1h-1zM6 1h1v1h-1zM8 1h1v1h-1zM10 1h3v1h-3zM14 1h1v1h-1zM18 1h1v1h-1zM24 1h1v1h-1zM0 2h1v1h-1zM2 2h3v1h-3zM6 2h1v1h-1zM8 2h1v1h-1zM10 2h1v1h-1zM12 2h1v1h-1zM14 2h3v1h-3zM18 2h1v1h-1zM20 2h3v1h-3zM24 2h1v1h-1zM0 3h1v1h-1zM2 3h3v1h-3zM6 3h1v1h-1zM8 3h1v1h-1zM11 3h1v1h-1zM13 3h1v1h-1zM15 3h2v1h-2zM18 3h1v1h-1zM20 3h3v1h-3zM24 3h1v1h-1zM0 4h1v1h-1zM2 4h3v1h-3zM6 4h1v1h-1zM10 4h1v1h-1zM15 4h2v1h-2zM18 4h1v1h-1zM20 4h3v1h-3zM24 4h1v1h-1zM0 5h1v1h-1zM6 5h1v1h-1zM9 5h1v1h-1zM11 5h2v1h-2zM18 5h1v1h-1zM24 5h1v1h-1zM0 6h7v1h-7zM8 6h1v1h-1zM10 6h1v1h-1zM12 6h1v1h-1zM14 6h1v1h-1zM16 6h1v1h-1zM18 6h7v1h-7zM8 7h1v1h-1zM14 7h1v1h-1zM16 7h1v1h-1zM0 8h1v1h-1zM6 8h1v1h-1zM8 8h4v1h-4zM13 8h6v1h-6zM21 8h3v1h-3zM3 9h1v1h-1zM7 9h2v1h-2zM10 9h3v1h-3zM15 9h1v1h-1zM20 9h4v1h-4zM1 10h3v1h-3zM5 10h2v1h-2zM10 10h4v1h-4zM15 10h3v1h-3zM21 10h1v1h-1zM23 10h2v1h-2zM0 11h1v1h-1zM4 11h2v1h-2zM8 11h1v1h-1zM10 11h1v1h-1zM12 11h1v1h-1zM14 11h1v1h-1zM16 11h1v1h-1zM19 11h1v1h-1zM21 11h1v1h-1zM24 11h1v1h-1zM0 12h1v1h-1zM3 12h1v1h-1zM5 12h2v1h-2zM9 12h2v1h-2zM12 12h1v1h-1zM15 12h2v1h-2zM18 12h1v1h-1zM24 12h1v1h-1zM0 13h1v1h-1zM2 13h1v1h-1zM4 13h2v1h-2zM10 13h1v1h-1zM13 13h1v1h-1zM15 13h2v1h-2zM19 13h1v1h-1zM23 13h1v1h-1zM0 14h1v1h-1zM2 14h1v1h-1zM4 14h1v1h-1zM6 14h1v1h-1zM8 14h1v1h-1zM11 14h2v1h-2zM15 14h3v1h-3zM19 14h3v1h-3zM23 14h2v1h-2zM0 15h1v1h-1zM3 15h1v1h-1zM8 15h1v1h-1zM11 15h1v1h-1zM14 15h2v1h-2zM17 15h3v1h-3zM21 15h2v1h-2zM24 15h1v1h-1zM0 16h1v1h-1zM2 16h1v1h-1zM4 16h1v1h-1zM6 16h3v1h-3zM11 16h2v1h-2zM14 16h7v1h-7zM22 16h1v1h-1zM8 17h3v1h-3zM12 17h3v1h-3zM16 17h1v1h-1zM20 17h1v1h-1zM0 18h7v1h-7zM11 18h2v1h-2zM15 18h2v1h-2zM18 18h1v1h-1zM20 18h1v1h-1zM24 18h1v1h-1zM0 19h1v1h-1zM6 19h1v1h-1zM14 19h3v1h-3zM20 19h1v1h-1zM23 19h2v1h-2zM0 20h1v1h-1zM2 20h3v1h-3zM6 20h1v1h-1zM9 20h1v1h-1zM13 20h8v1h-8zM22 20h1v1h-1zM0 21h1v1h-1zM2 21h3v1h-3zM6 21h1v1h-1zM9 21h1v1h-1zM11 21h1v1h-1zM14 21h2v1h-2zM17 21h2v1h-2zM23 21h2v1h-2zM0 22h1v1h-1zM2 22h3v1h-3zM6 22h1v1h-1zM10 22h1v1h-1zM13 22h1v1h-1zM16 22h1v1h-1zM21 22h2v1h-2zM24 22h1v1h-1zM0 23h1v1h-1zM6 23h1v1h-1zM9 23h1v1h-1zM11 23h1v1h-1zM16 23h5v1h-5zM24 23h1v1h-1zM0 24h7v1h-7zM8 24h3v1h-3zM12 24h1v1h-1zM15 24h2v1h-2zM18 24h1v1h-1zM21 24h1v1h-1zM24 24h1v1h-1z",
};

/** The code drawn in the current colour, `pixels` wide (a multiple of 25 keeps the modules sharp). */
export function BotQr({ pixels, className }: { pixels: number; className?: string }) {
  return (
    <svg className={className} width={pixels} height={pixels} viewBox={`0 0 ${BOT_QR.modules} ${BOT_QR.modules}`} shapeRendering="crispEdges" role="img" aria-label={`QR code for ${BOT_QR_URL}`}>
      <path d={BOT_QR.d} fill="currentColor" />
    </svg>
  );
}
