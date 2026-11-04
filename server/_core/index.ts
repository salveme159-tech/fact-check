import "dotenv/config";
import express from "express";
import path from "node:path";
import fs from "node:fs";
import { createServer } from "http";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "../routers";
import { createContext } from "./context";

async function startServer() {
  const app = express();
  const server = createServer(app);

  // 다른 주소(GitHub Pages 등)에서 접근하려면 CORS_ALLOWED_ORIGINS에 프론트 주소를 쉼표로 나열합니다.
  const allowedOrigins = new Set(
    (process.env.CORS_ALLOWED_ORIGINS ?? "").split(",").map(o => o.trim().replace(/\/$/, "")).filter(Boolean),
  );
  app.use((req, res, next) => {
    const origin = req.header("origin");
    if (origin && allowedOrigins.has(origin.replace(/\/$/, ""))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-OpenDART-Key");
    }
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  });
  app.use("/api/trpc", (_req, res, next) => { res.set("Cache-Control", "private, no-store, max-age=0"); res.set("Pragma", "no-cache"); next(); });
  app.use(express.json({ limit: "2mb" }));
  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  app.use("/api/trpc", createExpressMiddleware({ router: appRouter, createContext }));

  // 운영: 빌드된 정적 파일을 같은 서버에서 제공합니다(dist/public).
  const publicDir = path.resolve(import.meta.dirname, "public");
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
    app.get("*", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));
  }

  const port = Number(process.env.PORT || "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
  server.on("error", error => { console.error("Server failed:", error.message); process.exit(1); });
  server.listen(port, "0.0.0.0", () => console.log(`Server listening on port ${port}`));
}

startServer().catch(error => { console.error(error); process.exit(1); });
