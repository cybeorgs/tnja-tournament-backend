// Shared certificate loading used by both the admin and the public routes.
import type { Response } from "express";
import prisma from "../db.js";
import { env } from "../config/env.js";
import { notFound } from "../middleware/errors.js";
import { PLACEMENTS, type Placement } from "../lib/categories.js";
import { computePlacements, type Entrant, type Rounds } from "../lib/bracket.js";
import { categoryLabel, renderCertificates, type CertificateEvent } from "../lib/certificate.js";
import { getSettings } from "../lib/helpers.js";

type RegistrationWithStudent = Awaited<ReturnType<typeof loadRegistrations>>[number];

export function loadRegistrations(where: { tournamentId: string; id?: string | { in: string[] }; certificateNo?: string }) {
  return prisma.registration.findMany({
    where, include: { student: true }, orderBy: [{ ageGroup: "asc" }, { gender: "asc" }, { weightCategory: "asc" }, { student: { fullName: "asc" } }],
  });
}

/**
 * Placement to print: an explicit override, else the concluded placement, else what the
 * bracket says so far, else participation. Lets organisers print certificates at any time.
 */
async function resolvePlacements(registrations: RegistrationWithStudent[], override?: string): Promise<Map<string, Placement>> {
  const result = new Map<string, Placement>();
  const tournamentId = registrations[0]?.tournamentId;
  const draws = tournamentId ? await prisma.draw.findMany({ where: { tournamentId } }) : [];
  const fromBrackets: Record<string, Placement> = {};
  for (const d of draws) Object.assign(fromBrackets, computePlacements(d.entrants as unknown as Entrant[], d.rounds as unknown as Rounds).placements);

  for (const r of registrations) {
    const valid = override && (PLACEMENTS as readonly string[]).includes(override) ? (override as Placement) : undefined;
    result.set(r.id, valid ?? (r.placement as Placement | null) ?? fromBrackets[r.id] ?? "PARTICIPATION");
  }
  return result;
}

const eventOf = (t: { title: string; venue: string; city: string; startDate: Date; endDate: Date | null }): CertificateEvent => ({
  title: t.title, venue: t.venue, city: t.city, startDate: t.startDate, endDate: t.endDate,
});

export async function studentCertificatesPdf(tournamentId: string, registrations: RegistrationWithStudent[], override?: string) {
  const [tournament, settings] = await Promise.all([prisma.tournament.findUnique({ where: { id: tournamentId } }), getSettings()]);
  if (!tournament) throw notFound("Tournament");
  const placements = await resolvePlacements(registrations, override);
  return renderCertificates(
    registrations.map((r) => ({
      kind: "STUDENT" as const,
      certificateNo: r.certificateNo || r.id.slice(0, 8).toUpperCase(),
      name: r.student.fullName,
      club: r.student.club,
      district: r.student.district,
      placement: placements.get(r.id)!,
      category: categoryLabel(r.ageGroup, r.gender, r.weightCategory),
    })),
    eventOf(tournament), settings, env.publicSiteUrl,
  );
}

export async function officialCertificatesPdf(tournamentId: string, officialIds?: string[]) {
  const [tournament, settings, officials] = await Promise.all([
    prisma.tournament.findUnique({ where: { id: tournamentId } }),
    getSettings(),
    prisma.tournamentReferee.findMany({
      where: { tournamentId, ...(officialIds ? { id: { in: officialIds } } : {}) },
      include: { referee: true }, orderBy: { referee: { fullName: "asc" } },
    }),
  ]);
  if (!tournament) throw notFound("Tournament");
  if (!officials.length) throw notFound("Official");
  return renderCertificates(
    officials.map((o) => ({ kind: "REFEREE" as const, certificateNo: o.certificateNo, name: o.referee.fullName, district: o.referee.district, role: o.role })),
    eventOf(tournament), settings, env.publicSiteUrl,
  );
}

export function sendPdf(res: Response, bytes: Uint8Array, filename: string, download: boolean) {
  const safeName = filename.replace(/[^A-Za-z0-9._-]+/g, "_");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `${download ? "attachment" : "inline"}; filename="${safeName}"`);
  res.setHeader("Cache-Control", "no-store");
  res.end(Buffer.from(bytes));
}
