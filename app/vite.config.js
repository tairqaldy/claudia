import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: { outDir: "dist", target: "es2020", assetsInlineLimit: 0 },
  // `npm run dev` with ?mock shows the screens with sample data, no Telegram needed
  server: { proxy: { "/api": "http://127.0.0.1:47834" } },
});
