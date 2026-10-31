import { Router } from "express";
import { z } from "zod";
import prisma from "../db.js";
import { HttpError } from "../middleware/errors.js";
import { getSettings } from "../lib/helpers.js";

const router = Router();

const publicView = (s: Awaited<ReturnType<typeof getSettings>>) => ({
  orgName: s.orgName,
  orgShortName: s.orgShortName,
  tagline: s.tagline,
  signatory1Name: s.signatory1Name,
  signatory1Title: s.signatory1Title,
  signatory2Name: s.signatory2Name,
  signatory2Title: s.signatory2Title,
  hasLogo: !!s.logo,
  updatedAt: s.updatedAt,
});

router.get("/", async (_req, res) => {
  res.json(publicView(await getSettings()));
});

const settingsSchema = z.object({
  orgName: z.string().trim().min(1, "Organisation name is required").max(120),
  orgShortName: z.string().trim().min(1, "Short name is required").max(20),
  tagline: z.string().trim().max(160).default(""),
  signatory1Name: z.string().trim().max(80).default(""),
  signatory1Title: z.string().trim().max(80).default(""),
  signatory2Name: z.string().trim().max(80).default(""),
  signatory2Title: z.string().trim().max(80).default(""),
});

router.put("/", async (req, res) => {
  const data = settingsSchema.parse(req.body);
  await getSettings();
  const saved = await prisma.settings.update({ where: { id: "default" }, data });
  res.json(publicView(saved));
});

const logoSchema = z.object({
  /** data:image/png;base64,... */
  dataUrl: z.string().regex(/^data:image\/(png|jpeg|jpg);base64,/, "Logo must be a PNG or JPEG image"),
});

router.put("/logo", async (req, res) => {
  const { dataUrl } = logoSchema.parse(req.body);
  const [header, base64] = dataUrl.split(",", 2);
  const logo = Buffer.from(base64 || "", "base64");
  if (logo.length === 0) throw new HttpError(400, "Logo image is empty.");
  if (logo.length > 1024 * 1024) throw new HttpError(400, "Logo must be smaller than 1 MB.");
  const logoMime = header!.includes("png") ? "image/png" : "image/jpeg";
  await getSettings();
  const saved = await prisma.settings.update({ where: { id: "default" }, data: { logo, logoMime } });
  res.json(publicView(saved));
});

router.delete("/logo", async (_req, res) => {
  await getSettings();
  const saved = await prisma.settings.update({ where: { id: "default" }, data: { logo: null, logoMime: null } });
  res.json(publicView(saved));
});

export { publicView };
export default router;
