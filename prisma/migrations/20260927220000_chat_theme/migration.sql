-- Chat themes: a per-conversation look shared by both people.
ALTER TABLE "conversations" ADD COLUMN "chatTheme" TEXT NOT NULL DEFAULT 'classic';
