-- A ring that could not reach the callee: realtime-only calls end it at once.
ALTER TYPE "CallEndReason" ADD VALUE IF NOT EXISTS 'unavailable';
