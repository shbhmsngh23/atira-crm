-- ============================================================
-- 047_embedded_signup.sql — WhatsApp Embedded Signup
--
-- Embedded Signup connects a customer's WhatsApp number through Meta's
-- popup instead of pasted credentials. Registering the number needs a
-- six-digit two-step verification PIN; for these numbers Atira CRM
-- picks it, so it stores it (encrypted, like the access token) to be
-- able to register the number again later without the customer.
--
-- Numbers connected by hand keep NULL here: their PIN belongs to the
-- customer and is never stored.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS registration_pin TEXT;

COMMENT ON COLUMN whatsapp_config.registration_pin IS
  'Two-step verification PIN chosen by the app during Embedded Signup, encrypted with ENCRYPTION_KEY. NULL for numbers connected by hand.';
