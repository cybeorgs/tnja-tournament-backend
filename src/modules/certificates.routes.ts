// Organiser certificate downloads. Available at any time (before or after a category
// is concluded) so the organiser stays in full control.
import { Router } from "express";
import { z } from "zod";
import prisma from "../db.js";
import { HttpError, notFound } from "../middleware/errors.js";
import { findDraw, findTournament, param } from "../lib/helpers.js";
import { loadRegistrations, officialCertificatesPdf, sendPdf, studentCertificatesPdf } from "./certificates.js";

const router = Router({ mergeParams: true });

const downloadQuery = z.object({
  placement: z.string().optional(),
  download: z.enum(["0", "1"]).default("1"),
});

router.get("/registrations/:regId/certificate", async (req, res) => {
  const tournamentId = param(req, "id");
  const { placement, download } = downloadQuery.parse(req.query);
  const registrations = await loadRegistrations({ tournamentId, id: param(req, "regId") });
  if (!registrations.length) throw notFound("Registration");
  const pdf = await studentCertificatesPdf(tournamentId, registrations, placement);
  sendPdf(res, pdf, `${registrations[0]!.student.fullName}_certificate.pdf`, download === "1");
});

router.get("/officials/:officialId/certificate", async (req, res) => {
  const tournamentId = param(req, "id");
  const { download } = downloadQuery.parse(req.query);
  const official = await prisma.tournamentReferee.findFirst({ where: { id: param(req, "officialId"), tournamentId }, include: { referee: true } });
  if (!official) throw notFound("Official");
  const pdf = await officialCertificatesPdf(tournamentId, [official.id]);
  sendPdf(res, pdf, `${official.referee.fullName}_certificate.pdf`, download === "1");
});

const bulkQuery = z.object({
  kind: z.enum(["students", "officials"]).default("students"),
  /** Limit student certificates to one category */
  drawId: z.string().optional(),
  download: z.enum(["0", "1"]).default("1"),
});

/** All certificates in one PDF, one per page — handy for printing. */
router.get("/certificates", async (req, res) => {
  const tournament = await findTournament(param(req, "id"));
  const { kind, drawId, download } = bulkQuery.parse(req.query);

  if (kind === "officials") {
    const pdf = await officialCertificatesPdf(tournament.id);
    return sendPdf(res, pdf, `${tournament.title}_official_certificates.pdf`, download === "1");
  }

  let ids: string[] | undefined;
  let suffix = "all";
  if (drawId) {
    const draw = await findDraw(drawId);
    if (draw.tournamentId !== tournament.id) throw notFound("Draw");
    ids = draw.entrants.map((e) => e.id);
    suffix = `${draw.ageGroup}_${draw.gender}_${draw.weightCategory}`;
  }
  const registrations = await loadRegistrations({ tournamentId: tournament.id, ...(ids ? { id: { in: ids } } : {}) });
  if (!registrations.length) throw new HttpError(400, "There are no students to print certificates for.");
  const pdf = await studentCertificatesPdf(tournament.id, registrations);
  sendPdf(res, pdf, `${tournament.title}_certificates_${suffix}.pdf`, download === "1");
});

export default router;
