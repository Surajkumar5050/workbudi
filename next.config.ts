import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["googleapis"],
  // Required for fs.readFileSync in lib/gemini.ts to read the Robin system prompt .md file
  outputFileTracingIncludes: {
    "/api/**": ["./lib/prompts/**"],
  },
};

export default nextConfig;
