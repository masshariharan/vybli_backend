-- "Show All Users" — off for every existing account, and for new ones.
ALTER TABLE "privacy_settings" ADD COLUMN "showAllUsers" BOOLEAN NOT NULL DEFAULT false;
