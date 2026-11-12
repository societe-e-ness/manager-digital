-- Formats et images en URL (ticket 10) : chaque Publication porte son format (post, story) et les
-- images envoyées, décrites par leur URL publique. Une relance les réutilise : le nombre d'images à
-- joindre de nouveau (image_count, ticket 11) n'a plus lieu d'être.

-- AlterTable
ALTER TABLE "publication" DROP COLUMN "image_count",
ADD COLUMN     "format" TEXT NOT NULL DEFAULT 'post',
ADD COLUMN     "images" JSONB NOT NULL DEFAULT '[]';
