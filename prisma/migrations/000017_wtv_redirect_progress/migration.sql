ALTER TABLE "wtv_redirects"
ADD COLUMN "visitedUrls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
