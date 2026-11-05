import type { Metadata } from "next";
import { Instrument_Sans } from "next/font/google";
import type { ReactNode } from "react";

import { Shell } from "@/components/ui";
import { THEME_SCRIPT } from "@/lib/theme";
import { WalletProvider } from "@/lib/wallet";

import "./globals.css";

// The design system's one family (SIL Open Font License 1.1). next/font downloads it when the site is built
// and serves it from this site, so pages load no font from elsewhere.
const instrument = Instrument_Sans({ subsets: ["latin"], variable: "--font-instrument", display: "swap" });

const DESCRIPTION = "An AI agent that pays your suppliers under on-chain rules it cannot break.";
// The link preview (Telegram, X), named here rather than as app/opengraph-image.png: Next.js's Turbopack
// build ignores the alt text file that goes with that one.
const PREVIEW = { url: "/og.png", width: 1200, height: 630, alt: `GetLeash: ${DESCRIPTION}` };

// The icons are files in this folder (icon.svg, favicon.ico, apple-icon.png). Link previews name the
// preview image by the public site's address.
export const metadata: Metadata = {
  metadataBase: new URL("https://www.getleash.xyz"),
  title: "GetLeash",
  description: DESCRIPTION,
  openGraph: { type: "website", siteName: "GetLeash", title: "GetLeash", description: DESCRIPTION, images: [PREVIEW] },
  twitter: { card: "summary_large_image", images: [PREVIEW] },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // THEME_SCRIPT sets <html data-theme> (and data-telegram) before the first paint, hence suppressHydrationWarning.
  return (
    <html lang="en" className={instrument.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <WalletProvider>
          <Shell>{children}</Shell>
        </WalletProvider>
      </body>
    </html>
  );
}
