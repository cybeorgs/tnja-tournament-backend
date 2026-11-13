// Units a player can represent instead of a district (Admin → Units). Players store the unit's name,
// so renaming a unit renames it on every player, and a unit players represent can't be deleted.
import { Router } from "express";
import { z } from "zod";
import prisma from "../db.js";
import { HttpError, notFound } from "../middleware/errors.js";
import { param } from "../lib/helpers.js";

const unitSchema = z.object({
  name: z.string().trim().min(2, "Unit name is required").max(120).transform((s) => s.replace(/\s+/g, " ")),
});

async function assertNameFree(name: string, exceptId?: string) {
  const other = await prisma.unit.findFirst({ where: { name: { equals: name, mode: "insensitive" }, ...(exceptId ? { NOT: { id: exceptId } } : {}) } });
  if (other) throw new HttpError(409, `There is already a unit called "${other.name}".`);
}

/** Public: the names for the registration form's dropdown. */
export const publicUnitRoutes = Router();
publicUnitRoutes.get("/", async (_req, res) => {
  const units = await prisma.unit.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } });
  res.json(units);
});

const router = Router();

/** Every unit with how many players represent it. */
router.get("/", async (_req, res) => {
  const [units, counts] = await Promise.all([
    prisma.unit.findMany({ orderBy: { name: "asc" } }),
    prisma.student.groupBy({ by: ["representingUnit"], where: { representing: "UNIT" }, _count: { _all: true } }),
  ]);
  const players = new Map(counts.map((c) => [c.representingUnit, c._count._all]));
  res.json(units.map((u) => ({ ...u, players: players.get(u.name) ?? 0 })));
});

router.post("/", async (req, res) => {
  const { name } = unitSchema.parse(req.body);
  await assertNameFree(name);
  res.status(201).json(await prisma.unit.create({ data: { name } }));
});

router.put("/:id", async (req, res) => {
  const id = param(req, "id");
  const { name } = unitSchema.parse(req.body);
  const existing = await prisma.unit.findUnique({ where: { id } });
  if (!existing) throw notFound("Unit");
  await assertNameFree(name, id);
  const unit = await prisma.$transaction(async (tx) => {
    await tx.student.updateMany({ where: { representing: "UNIT", representingUnit: existing.name }, data: { representingUnit: name } });
    return tx.unit.update({ where: { id }, data: { name } });
  });
  res.json(unit);
});

router.delete("/:id", async (req, res) => {
  const unit = await prisma.unit.findUnique({ where: { id: param(req, "id") } });
  if (!unit) throw notFound("Unit");
  const players = await prisma.student.count({ where: { representing: "UNIT", representingUnit: unit.name } });
  if (players) throw new HttpError(409, `${players} player${players === 1 ? "" : "s"} represent ${unit.name}. Move them to another unit or district first.`);
  await prisma.unit.delete({ where: { id: unit.id } });
  res.json({ message: "Unit deleted." });
});

export default router;
