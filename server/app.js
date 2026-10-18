import express from "express";
import multer from "multer";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DocumentStore } from "./store.js";
import { pdfController } from "./controllers/pdf-controller.js";

export function createApp({
  store = new DocumentStore(),
  appOrigin = process.env.APP_ORIGIN,
} = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(
    helmet({ contentSecurityPolicy: false, crossOriginOpenerPolicy: false }),
  );
  app.use("/api", (request, response, next) => {
    response.set("Cache-Control", "no-store");
    const origin = request.get("origin");
    const expected =
      appOrigin || `${request.protocol}://${request.get("host")}`;
    if (origin && origin !== expected)
      return response.status(403).json({ error: "Origen no autorizado." });
    next();
  });
  app.use(
    "/api",
    rateLimit({
      windowMs: 60000,
      limit: 120,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { error: "Demasiadas peticiones. Espera un minuto." },
    }),
  );
  app.use(express.json({ limit: "32kb" }));
  app.get("/api/health", (_request, response) =>
    response.json({ status: "ok" }),
  );
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 10 * 1024 * 1024,
      files: 10,
      fields: 1,
      fieldSize: 48 * 1024,
      parts: 11,
    },
  }).array("files", 10);
  const controller = pdfController(store);
  let activePreparations = 0;
  app.post(
    "/api/pdf/prepare",
    (request, response, next) => {
      if (activePreparations >= 2)
        return response
          .status(503)
          .json({ error: "Servidor ocupado. Intentalo mas tarde." });
      activePreparations++;
      let released = false;
      const release = () => {
        if (!released) {
          activePreparations--;
          released = true;
        }
      };
      response.once("close", release);
      response.once("finish", release);
      next();
    },
    upload,
    controller.prepare,
  );
  app.post("/api/pdf/inject", controller.inject);
  app.use("/api", (_request, response) =>
    response.status(404).json({ error: "Endpoint no encontrado." }),
  );
  const dist = fileURLToPath(new URL("../dist/", import.meta.url));
  if (existsSync(dist)) app.use(express.static(dist));
  app.use((error, _request, response, _next) => {
    const status =
      error instanceof multer.MulterError ? 413 : error.status || 500;
    response.status(status).json({
      error: status === 500 ? "Error interno del servidor." : error.message,
    });
  });
  return { app, store };
}
