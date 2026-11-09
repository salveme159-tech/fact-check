import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  // GitHub Pages는 /dart_navigator/ 하위 경로, 서버가 사이트까지 함께 서비스하는 배포(Docker/Render)는 VITE_BASE=/ 로 빌드합니다.
  base: process.env.VITE_BASE ?? "/dart_navigator/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
    },
  },
  envDir: path.resolve(import.meta.dirname),
  root: path.resolve(import.meta.dirname, "client"),
  publicDir: path.resolve(import.meta.dirname, "client", "public"),
  build: { outDir: path.resolve(import.meta.dirname, "dist/public"), emptyOutDir: true },
  // 개발 시 npm run dev(서버 3000)와 npm run dev:client(화면 5173)를 함께 실행하면 /api 요청이 서버로 전달됩니다.
  server: { proxy: { "/api": "http://localhost:3000" } },
});
