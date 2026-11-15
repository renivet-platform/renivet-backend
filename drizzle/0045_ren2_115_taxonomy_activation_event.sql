-- REN2-115: allow the audited category activation lifecycle event.
ALTER TABLE catalogue.taxonomy_admin_events
  DROP CONSTRAINT taxonomy_admin_events_action_check;

ALTER TABLE catalogue.taxonomy_admin_events
  ADD CONSTRAINT taxonomy_admin_events_action_check
  CHECK (action IN ('propose', 'publish', 'activate'));
