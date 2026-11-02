import type { NextConfig } from "next";

const config: NextConfig = {
  // Workspace packages are TypeScript sources.
  transpilePackages: ["@getleash/shared", "@getleash/agent", "@getleash/ingestion"],
  // The private view reads local files (.data/) only on a self-hosted server.
  serverExternalPackages: ["pdfjs-dist", "@phala/dcap-qvl"],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default config;
