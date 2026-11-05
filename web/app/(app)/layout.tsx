import type { ReactNode } from "react";

import { Shell } from "@/components/ui";
import { WalletProvider } from "@/lib/wallet";

/**
 * The dashboard: every page the bot's buttons open (payments, setup, suppliers, wallet, pause), with the
 * owner's wallet and the dashboard's header and footer. The landing page (app/page.tsx) has neither.
 */
export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <WalletProvider>
      <Shell>{children}</Shell>
    </WalletProvider>
  );
}
