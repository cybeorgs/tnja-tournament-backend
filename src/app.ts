import express from "express";
import cors from "cors";
import { env } from "./config/env.js";
import { requireAdmin } from "./middleware/auth.js";
import { errorHandler } from "./middleware/errors.js";
import authRoutes from "./modules/auth.routes.js";
import settingsRoutes from "./modules/settings.routes.js";
import { refereesRouter, studentsRouter } from "./modules/people.routes.js";
import tournamentRoutes from "./modules/tournaments.routes.js";
import entryImportRoutes from "./modules/entryImport.routes.js";
import { drawsRouter, tournamentDrawsRouter } from "./modules/draws.routes.js";
import certificateRoutes from "./modules/certificates.routes.js";
import publicRoutes from "./modules/public.routes.js";
import selfServiceRoutes from "./modules/selfService.routes.js";
import aadhaarRoutes from "./modules/aadhaar.routes.js";
import { studentAuthRouter, studentRouter } from "./modules/studentAuth.routes.js";
import paymentRoutes from "./modules/payments.routes.js";
import auditRoutes from "./modules/audit.routes.js";
import emailRoutes from "./modules/email.routes.js";
import unitRoutes, { publicUnitRoutes } from "./modules/units.routes.js";

export function createApp() {
  const app = express();
  app.set("trust proxy", 1); // behind Nginx: req.ip is the real client for rate limiting
  app.use(cors({ origin: env.corsOrigins, exposedHeaders: ["Content-Disposition"] }));
  app.use(express.json({ limit: "6mb" })); // logo, photo and document uploads arrive as base64

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use("/api/auth", authRoutes);
  app.use("/api/public", publicRoutes);
  app.use("/api/public", selfServiceRoutes);
  app.use("/api/public", aadhaarRoutes);
  app.use("/api/public/units", publicUnitRoutes);
  app.use("/api/student-auth", studentAuthRouter);
  app.use("/api/student", studentRouter);

  // Everything below needs a logged-in admin.
  const admin = express.Router();
  admin.use(requireAdmin);
  admin.use("/settings", settingsRoutes);
  admin.use("/students", studentsRouter);
  admin.use("/referees", refereesRouter);
  admin.use("/tournaments/:id", entryImportRoutes); // before the tournament routes so "import" is never read as an id
  admin.use("/tournaments", tournamentRoutes);
  admin.use("/tournaments/:id", tournamentDrawsRouter);
  admin.use("/tournaments/:id", certificateRoutes);
  admin.use("/draws", drawsRouter);
  admin.use("/payments", paymentRoutes);
  admin.use("/audit", auditRoutes);
  admin.use("/email", emailRoutes);
  admin.use("/units", unitRoutes);
  app.use("/api", admin);

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found." });
  });
  app.use(errorHandler);
  return app;
}
