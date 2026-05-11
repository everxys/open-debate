import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = process.env.OPEN_DEBATE_NEXT_DIST_DIR || ".next";

/** @type {import('next').NextConfig} */
const nextConfig = {
  typedRoutes: true,
  outputFileTracingRoot: __dirname,
  distDir,
  webpack(config, { dev }) {
    if (dev) {
      config.cache = {
        type: "memory"
      };
    }
    return config;
  }
};

export default nextConfig;
