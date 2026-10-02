-- ============================================================
-- 045_broadcast_queue.sql — Server-side broadcast sending + scheduling
--
-- Dashboard broadcasts used to be sent by the browser tab that created
-- them: close the tab and the campaign stopped. Sending now happens on
-- the server (src/lib/whatsapp/broadcast-queue.ts): the request that
-- creates a broadcast starts it, and GET /api/broadcasts/cron continues
-- long ones and starts scheduled ones.
--
-- What this migration does
--   1. `broadcasts.header_media_url` — the image / video / document for
--      a media-header template. The tab used to pass it on every send;
--      the server now needs it stored with the broadcast.
--   2. An index for the worker's two scans: due scheduled broadcasts
--      and broadcasts still sending.
--
-- `broadcasts.scheduled_at` and the 'scheduled' status already exist
-- (migration 001).
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS header_media_url TEXT;

CREATE INDEX IF NOT EXISTS idx_broadcasts_queue
  ON broadcasts(status, scheduled_at)
  WHERE status IN ('scheduled', 'sending');
