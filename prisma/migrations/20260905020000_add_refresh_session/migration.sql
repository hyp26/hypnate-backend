CREATE TABLE "RefreshSession" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RefreshSession_tokenHash_key"
ON "RefreshSession"("tokenHash");

CREATE INDEX "RefreshSession_userId_idx"
ON "RefreshSession"("userId");

CREATE INDEX "RefreshSession_expiresAt_idx"
ON "RefreshSession"("expiresAt");

CREATE INDEX "RefreshSession_revokedAt_idx"
ON "RefreshSession"("revokedAt");

ALTER TABLE "RefreshSession"
ADD CONSTRAINT "RefreshSession_userId_fkey"
FOREIGN KEY ("userId")
REFERENCES "User"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;