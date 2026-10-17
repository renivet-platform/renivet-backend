import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
// Foundation-only example table. Domain DDL requires D02 and Phase 4 sign-off.
export const systemEvents = pgTable('system_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  eventName: text('event_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
