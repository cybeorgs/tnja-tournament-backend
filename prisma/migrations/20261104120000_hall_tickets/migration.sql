-- Hall tickets, the passport photo (a StudentDocument of kind PHOTO) and the additional player details.
ALTER TABLE "Settings" ADD COLUMN "regNo" TEXT NOT NULL DEFAULT '329-2017';

ALTER TABLE "Student"
    ADD COLUMN "weightKg" DOUBLE PRECISION,
    ADD COLUMN "managerName" TEXT NOT NULL DEFAULT '',
    ADD COLUMN "districtPresident" TEXT NOT NULL DEFAULT '',
    ADD COLUMN "districtSecretary" TEXT NOT NULL DEFAULT '';

ALTER TABLE "Registration" ADD COLUMN "hallTicketSentAt" TIMESTAMP(3);
