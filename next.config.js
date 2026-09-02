/**
 * Two build targets share this config:
 *   default          -> a Next server with edge API routes (the web app)
 *   ALOO_STATIC=1    -> a static bundle in ./out for the Capacitor Android shell
 *
 * The static target cannot host API routes; scripts/build-static.mjs moves them
 * aside for the export, and lib/runtime.js routes the app to the providers
 * directly when it detects the native shell.
 *
 * @type {import('next').NextConfig}
 */
const isStatic = process.env.ALOO_STATIC === '1';

const nextConfig = {
  reactStrictMode: true,
  ...(isStatic
    ? {
        output: 'export',
        // No Next server means no image optimiser endpoint.
        images: { unoptimized: true },
        // Directory-style URLs load reliably from the WebView's asset server.
        trailingSlash: true,
      }
    : {}),
  // three.js ships untranspiled ESM examples; Next handles it, but we keep the
  // transpile list explicit so drei's deep imports never break the build.
  transpilePackages: ['three', '@react-three/fiber', '@react-three/drei'],
};

module.exports = nextConfig;
