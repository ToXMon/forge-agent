import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // The parent forge/ repo has its own package-lock.json; pin the root so
  // Turbopack resolves modules from ui/node_modules.
  turbopack: {
    root: __dirname,
  },
  // BrowserPod's Wasm runtime needs SharedArrayBuffer, which Chrome only
  // exposes on cross-origin-isolated pages. credentialless keeps cross-origin
  // loads (rt.browserpod.io) working without CORP headers on them.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
        ],
      },
    ];
  },
};

export default nextConfig;
