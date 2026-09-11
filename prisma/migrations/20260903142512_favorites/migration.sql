-- CreateTable
CREATE TABLE "favorites" (
    "id" TEXT NOT NULL,
    "favoritedById" TEXT NOT NULL,
    "favoriteUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "favorites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "favorites_favoriteUserId_idx" ON "favorites"("favoriteUserId");

-- CreateIndex
CREATE UNIQUE INDEX "favorites_favoritedById_favoriteUserId_key" ON "favorites"("favoritedById", "favoriteUserId");

-- AddForeignKey
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_favoritedById_fkey" FOREIGN KEY ("favoritedById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_favoriteUserId_fkey" FOREIGN KEY ("favoriteUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
