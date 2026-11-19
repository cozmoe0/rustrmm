-- Agent updates: automatic rollouts driven by the `agent_updates.auto_update` policy, and pruning
-- of old release artifacts (the row and its rollout history stay; only the files go).

-- manual: created by a person (release rollout, "Update now"); auto: created by the server for
-- devices whose policy allows automatic updates (one per release).
ALTER TABLE rollouts ADD COLUMN kind TEXT NOT NULL DEFAULT 'manual';
CREATE INDEX rollouts_release_kind ON rollouts (release_id, kind);

-- Set when the release's artifacts were deleted to save space; it can no longer be rolled out.
ALTER TABLE agent_releases ADD COLUMN pruned_at TEXT;
