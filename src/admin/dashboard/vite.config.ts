import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/0x/",
  server: {
    port: 3900,
    proxy: {
      "/0x/api": {
        target: "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: "assets/ashs-[name]-[hash].js",
        chunkFileNames: "assets/ashs-[name]-[hash].js",
        assetFileNames: "assets/ashs-[name]-[hash].[ext]",
      },
    },
  },
  css: {
    postcss: {},
  },
});
