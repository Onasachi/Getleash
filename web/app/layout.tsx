import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Shell } from "@/components/ui";
import { WalletProvider } from "@/lib/wallet";

import "./globals.css";

export const metadata: Metadata = {
  title: "GetLeash",
  description: "An AI agent that pays your suppliers under on-chain rules it cannot break.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WalletProvider>
          <Shell>{children}</Shell>
        </WalletProvider>
      </body>
    </html>
  );
}
