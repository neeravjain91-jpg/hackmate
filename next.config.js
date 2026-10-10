/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Ensure Next.js doesn't parse or process archived directory
  webpack: (config) => {
    config.watchOptions = {
      ...config.watchOptions,
      ignored: ['**/_satellite_embedding_archive/**', '**/node_modules/**'],
    };
    return config;
  },
};

module.exports = nextConfig;
