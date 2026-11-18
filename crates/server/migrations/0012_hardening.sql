-- Phase 11 part B: Noise IK channel and webhook debouncing (additive; see docs/api-platform.md).

-- The agent's Noise static key (`x25519:<base64>`), registered at enrollment or on the first
-- connection of an upgraded agent, always vouched for by the device key.
ALTER TABLE devices ADD COLUMN noise_public_key TEXT;

-- How the last control connection ended (`disconnected` | `connection_lost`) and when the
-- debounced `device.offline` webhook event was sent for the current offline period.
ALTER TABLE devices ADD COLUMN offline_reason TEXT;
ALTER TABLE devices ADD COLUMN offline_notified_at TEXT;
-- Devices already offline were notified under the previous (immediate) behaviour.
UPDATE devices SET offline_notified_at = COALESCE(last_seen_at, created_at) WHERE online = 0;
