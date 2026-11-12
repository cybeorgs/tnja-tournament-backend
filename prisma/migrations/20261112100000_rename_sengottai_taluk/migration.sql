-- Tenkasi district's "Shencottai" taluk is now listed as "Sengottai" (the spelling India Post uses).
UPDATE "Student" SET "taluk" = 'Sengottai' WHERE "taluk" IN ('Shencottai', 'Shenkottai', 'Senkottai');
