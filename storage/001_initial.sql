-- ACS initial schema
-- SQLite 3.38+; applied by the daemon in one migration transaction.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL COLLATE NOCASE,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  skills_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(skills_json)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  profile_revision INTEGER NOT NULL DEFAULT 1 CHECK (profile_revision > 0),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER,
  CHECK (length(id) BETWEEN 5 AND 128),
  CHECK (length(slug) BETWEEN 1 AND 63),
  CHECK (length(display_name) BETWEEN 1 AND 128)
) STRICT;

CREATE UNIQUE INDEX agents_slug_active_uq
  ON agents(slug)
  WHERE deleted_at_ms IS NULL;

CREATE TABLE runtime_installations (
  id TEXT PRIMARY KEY,
  harness_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  label TEXT NOT NULL,
  endpoint_json TEXT NOT NULL CHECK (json_valid(endpoint_json)),
  capabilities_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(capabilities_json)),
  protocol_fingerprint TEXT,
  state TEXT NOT NULL DEFAULT 'unknown' CHECK (
    state IN ('unknown', 'online', 'degraded', 'offline', 'incompatible')
  ),
  last_seen_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE(harness_id, label)
) STRICT;

CREATE TABLE runtime_bindings (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  installation_id TEXT NOT NULL REFERENCES runtime_installations(id),
  session_opaque_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK (epoch > 0),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'active', 'stale', 'revoked')
  ),
  continuity_policy TEXT NOT NULL DEFAULT 'follow-pending' CHECK (
    continuity_policy IN ('follow-pending', 'strict')
  ),
  delivery_policy_json TEXT NOT NULL CHECK (json_valid(delivery_policy_json)),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  last_observed_availability TEXT CHECK (
    last_observed_availability IS NULL OR
    last_observed_availability IN (
      'unknown', 'offline', 'dormant', 'idle', 'busy',
      'awaiting-local-input', 'degraded'
    )
  ),
  last_observed_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  activated_at_ms INTEGER,
  revoked_at_ms INTEGER,
  revocation_reason TEXT,
  UNIQUE(agent_id, epoch)
) STRICT;

CREATE UNIQUE INDEX runtime_bindings_active_agent_uq
  ON runtime_bindings(agent_id)
  WHERE status = 'active';

CREATE UNIQUE INDEX runtime_bindings_active_session_uq
  ON runtime_bindings(installation_id, session_opaque_id)
  WHERE status = 'active';

CREATE INDEX runtime_bindings_session_idx
  ON runtime_bindings(installation_id, session_opaque_id);

CREATE TABLE principals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (
    kind IN ('local-user', 'bound-agent', 'service', 'external-a2a-client')
  ),
  agent_id TEXT REFERENCES agents(id),
  binding_id TEXT REFERENCES runtime_bindings(id),
  display_name TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(scopes_json)),
  created_at_ms INTEGER NOT NULL,
  disabled_at_ms INTEGER
) STRICT;

CREATE INDEX principals_agent_idx ON principals(agent_id);
CREATE INDEX principals_binding_idx ON principals(binding_id);

CREATE TABLE auth_tokens (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  token_hash BLOB NOT NULL UNIQUE,
  token_hint TEXT,
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
  issued_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER,
  revoked_at_ms INTEGER,
  last_used_at_ms INTEGER
) STRICT;

CREATE INDEX auth_tokens_principal_idx ON auth_tokens(principal_id);

CREATE TABLE binding_claims (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  code_hash BLOB NOT NULL UNIQUE,
  created_by_principal_id TEXT NOT NULL REFERENCES principals(id),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  consumed_at_ms INTEGER,
  consumed_by_binding_id TEXT REFERENCES runtime_bindings(id),
  CHECK (expires_at_ms > created_at_ms)
) STRICT;

CREATE INDEX binding_claims_agent_idx ON binding_claims(agent_id);

CREATE TABLE conversation_contexts (
  id TEXT PRIMARY KEY,
  target_agent_id TEXT NOT NULL REFERENCES agents(id),
  requester_principal_id TEXT NOT NULL REFERENCES principals(id),
  requester_agent_id TEXT REFERENCES agents(id),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX conversation_contexts_target_idx
  ON conversation_contexts(target_agent_id, updated_at_ms DESC);
CREATE INDEX conversation_contexts_requester_idx
  ON conversation_contexts(requester_principal_id, updated_at_ms DESC);

CREATE TABLE a2a_tasks (
  id TEXT PRIMARY KEY,
  context_id TEXT NOT NULL REFERENCES conversation_contexts(id),
  target_agent_id TEXT NOT NULL REFERENCES agents(id),
  requester_principal_id TEXT NOT NULL REFERENCES principals(id),
  requester_agent_id TEXT REFERENCES agents(id),
  state TEXT NOT NULL CHECK (
    state IN (
      'submitted', 'working', 'input-required', 'auth-required',
      'completed', 'failed', 'canceled', 'rejected'
    )
  ),
  state_version INTEGER NOT NULL DEFAULT 1 CHECK (state_version > 0),
  next_event_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_event_sequence > 0),
  cancellation_requested INTEGER NOT NULL DEFAULT 0 CHECK (
    cancellation_requested IN (0, 1)
  ),
  summary TEXT,
  a2a_snapshot_json TEXT NOT NULL CHECK (json_valid(a2a_snapshot_json)),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  terminal_at_ms INTEGER
) STRICT;

CREATE INDEX a2a_tasks_target_state_idx
  ON a2a_tasks(target_agent_id, state, updated_at_ms DESC);
CREATE INDEX a2a_tasks_requester_state_idx
  ON a2a_tasks(requester_principal_id, state, updated_at_ms DESC);
CREATE INDEX a2a_tasks_context_idx
  ON a2a_tasks(context_id, created_at_ms);

CREATE TABLE a2a_messages (
  id TEXT PRIMARY KEY,
  external_message_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES a2a_tasks(id),
  context_id TEXT NOT NULL REFERENCES conversation_contexts(id),
  sender_principal_id TEXT NOT NULL REFERENCES principals(id),
  sender_agent_id TEXT REFERENCES agents(id),
  target_agent_id TEXT NOT NULL REFERENCES agents(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'agent')),
  parts_json TEXT NOT NULL CHECK (json_valid(parts_json)),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  canonical_hash TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(sender_principal_id, target_agent_id, external_message_id)
) STRICT;

CREATE INDEX a2a_messages_task_idx
  ON a2a_messages(task_id, created_at_ms, id);

CREATE TABLE task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES a2a_tasks(id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'task-created',
      'message-received',
      'delivery-queued',
      'delivery-deferred',
      'delivery-accepted',
      'delivery-acceptance-unknown',
      'task-working',
      'message-published',
      'artifact-published',
      'input-required',
      'cancellation-requested',
      'task-completed',
      'task-failed',
      'task-canceled',
      'task-rejected',
      'operator-resolution'
    )
  ),
  actor_principal_id TEXT REFERENCES principals(id),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at_ms INTEGER NOT NULL,
  UNIQUE(task_id, sequence)
) STRICT;

CREATE INDEX task_events_task_created_idx
  ON task_events(task_id, created_at_ms, sequence);

CREATE TRIGGER task_events_no_update
BEFORE UPDATE ON task_events
BEGIN
  SELECT RAISE(ABORT, 'TASK_EVENT_IMMUTABLE');
END;

CREATE TRIGGER task_events_no_delete
BEFORE DELETE ON task_events
BEGIN
  SELECT RAISE(ABORT, 'TASK_EVENT_IMMUTABLE');
END;

CREATE TABLE task_subscriptions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES a2a_tasks(id),
  subscriber_principal_id TEXT NOT NULL REFERENCES principals(id),
  subscriber_agent_id TEXT REFERENCES agents(id),
  origin_binding_id TEXT REFERENCES runtime_bindings(id),
  origin_binding_epoch INTEGER,
  event_filter_json TEXT NOT NULL CHECK (json_valid(event_filter_json)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'paused', 'closed')
  ),
  last_notified_sequence INTEGER NOT NULL DEFAULT 0 CHECK (
    last_notified_sequence >= 0
  ),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX task_subscriptions_task_status_idx
  ON task_subscriptions(task_id, status);

CREATE TABLE delivery_intents (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (
    kind IN ('a2a-message', 'task-event-notification')
  ),
  task_id TEXT REFERENCES a2a_tasks(id),
  message_id TEXT REFERENCES a2a_messages(id),
  target_agent_id TEXT NOT NULL REFERENCES agents(id),
  pinned_binding_id TEXT REFERENCES runtime_bindings(id),
  pinned_binding_epoch INTEGER,
  mode TEXT NOT NULL DEFAULT 'direct' CHECK (mode = 'direct'),
  priority INTEGER NOT NULL DEFAULT 10,
  state TEXT NOT NULL CHECK (
    state IN (
      'pending', 'leased', 'attempting', 'deferred', 'accepted',
      'acceptance-unknown', 'failed-terminal', 'canceled', 'superseded'
    )
  ),
  state_reason TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  not_before_ms INTEGER NOT NULL,
  deadline_ms INTEGER,
  lease_owner TEXT,
  lease_generation INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  lease_expires_at_ms INTEGER,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  payload_hash TEXT NOT NULL,
  runtime_execution_id TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK (
    (pinned_binding_id IS NULL AND pinned_binding_epoch IS NULL) OR
    (pinned_binding_id IS NOT NULL AND pinned_binding_epoch IS NOT NULL)
  )
) STRICT;

CREATE INDEX delivery_intents_due_idx
  ON delivery_intents(state, not_before_ms, priority DESC, created_at_ms);
CREATE INDEX delivery_intents_target_idx
  ON delivery_intents(target_agent_id, state, created_at_ms);
CREATE INDEX delivery_intents_task_idx
  ON delivery_intents(task_id, created_at_ms);

CREATE TABLE delivery_attempts (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES delivery_intents(id),
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  adapter_id TEXT NOT NULL,
  binding_id TEXT NOT NULL REFERENCES runtime_bindings(id),
  binding_epoch INTEGER NOT NULL CHECK (binding_epoch > 0),
  started_at_ms INTEGER NOT NULL,
  request_flushed_at_ms INTEGER,
  completed_at_ms INTEGER,
  outcome TEXT CHECK (
    outcome IS NULL OR outcome IN (
      'accepted', 'deferred', 'rejected', 'acceptance-unknown'
    )
  ),
  runtime_execution_opaque_id TEXT,
  error_code TEXT,
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  reconciliation_token TEXT,
  evidence_json TEXT CHECK (evidence_json IS NULL OR json_valid(evidence_json)),
  UNIQUE(intent_id, attempt_number)
) STRICT;

CREATE INDEX delivery_attempts_intent_idx
  ON delivery_attempts(intent_id, attempt_number DESC);

CREATE TRIGGER delivery_attempts_completed_immutable
BEFORE UPDATE ON delivery_attempts
WHEN OLD.outcome IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'DELIVERY_ATTEMPT_IMMUTABLE');
END;

CREATE TRIGGER delivery_attempts_no_delete
BEFORE DELETE ON delivery_attempts
BEGIN
  SELECT RAISE(ABORT, 'DELIVERY_ATTEMPT_IMMUTABLE');
END;

CREATE TABLE runtime_executions (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL UNIQUE REFERENCES delivery_intents(id),
  binding_id TEXT NOT NULL REFERENCES runtime_bindings(id),
  binding_epoch INTEGER NOT NULL CHECK (binding_epoch > 0),
  runtime_execution_opaque_id TEXT NOT NULL,
  relationship TEXT NOT NULL DEFAULT 'unknown' CHECK (
    relationship IN ('started', 'joined', 'unknown')
  ),
  state TEXT NOT NULL CHECK (
    state IN (
      'accepted', 'started', 'awaiting-local-input',
      'completed', 'failed', 'interrupted', 'unknown'
    )
  ),
  final_parts_json TEXT CHECK (
    final_parts_json IS NULL OR json_valid(final_parts_json)
  ),
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  accepted_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER,
  completed_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX runtime_executions_binding_state_idx
  ON runtime_executions(binding_id, state, updated_at_ms);
CREATE INDEX runtime_executions_runtime_turn_idx
  ON runtime_executions(binding_id, runtime_execution_opaque_id, updated_at_ms);

CREATE TABLE idempotency_records (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('in-progress', 'committed')),
  response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER,
  PRIMARY KEY(scope, key)
) WITHOUT ROWID, STRICT;

CREATE INDEX idempotency_records_expiry_idx
  ON idempotency_records(expires_at_ms)
  WHERE expires_at_ms IS NOT NULL;

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  actor_principal_id TEXT REFERENCES principals(id),
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  correlation_id TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX audit_events_created_idx
  ON audit_events(created_at_ms DESC);
CREATE INDEX audit_events_resource_idx
  ON audit_events(resource_type, resource_id, created_at_ms DESC);
