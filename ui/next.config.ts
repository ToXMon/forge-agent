import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // The parent forge/ repo has its own package-lock.json; pin the root so
  // Turbopack resolves modules from ui/node_modules.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
