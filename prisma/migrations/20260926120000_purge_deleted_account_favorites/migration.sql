-- Favourites involving a deleted account, left behind by `deleteAccount`
-- before it removed them itself. Deleted accounts are soft-deleted (the
-- `users` row stays for history), so the `ON DELETE CASCADE` on these foreign
-- keys never fired for them.
DELETE FROM "favorites"
WHERE "favoriteUserId" IN (
        SELECT "id" FROM "users" WHERE "status" = 'deleted' OR "deletedAt" IS NOT NULL
    )
   OR "favoritedById" IN (
        SELECT "id" FROM "users" WHERE "status" = 'deleted' OR "deletedAt" IS NOT NULL
    );
