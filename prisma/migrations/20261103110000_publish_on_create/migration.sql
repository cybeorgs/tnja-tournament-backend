-- Tournaments are published as soon as they are created; there is no draft stage any more.
ALTER TABLE "Tournament" ALTER COLUMN "status" SET DEFAULT 'PUBLISHED';
UPDATE "Tournament" SET "status" = 'PUBLISHED', "publishedAt" = COALESCE("publishedAt", now()) WHERE "status" = 'DRAFT';
