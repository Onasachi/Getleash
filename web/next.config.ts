import type { NextConfig } from "next";

const config: NextConfig = {
  // A second `next dev` (say, against `pnpm devnet` while another dashboard runs) needs its own build folder.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Workspace packages are TypeScript sources.
  transpilePackages: ["@getleash/shared", "@getleash/agent", "@getleash/ingestion", "@getleash/channel-mcp"],
  // The private view reads local files (.data/) only on a self-hosted server.
  serverExternalPackages: ["pdfjs-dist", "@phala/dcap-qvl"],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          // No page may frame the dashboard except Telegram's web client, which shows Mini Apps in a frame
          // (the bot's buttons open payment pages inside Telegram). Telegram's apps use their own webview.
          { key: "Content-Security-Policy", value: "frame-ancestors 'self' https://web.telegram.org" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default config;
