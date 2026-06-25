import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';

export const reports = sqliteTable('reports', {
  id:          integer('id').primaryKey({ autoIncrement: true }),
  lineNum:     text('line_num').notNull(),
  deviceId:    text('device_id').notNull(),
  category:    text('category').notNull(),
  station:     text('station'),
  description: text('description'),
  imageB64:    text('image_b64'),
  netVotes:    integer('net_votes').notNull().default(0),
  promoted:    integer('promoted').notNull().default(0),
  createdAt:   integer('created_at').notNull(),
  expiresAt:   integer('expires_at').notNull(),
});

export const reportVotes = sqliteTable('report_votes', {
  reportId: integer('report_id').notNull().references(() => reports.id, { onDelete: 'cascade' }),
  deviceId: text('device_id').notNull(),
  vote:     integer('vote').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.reportId, t.deviceId] }),
}));

export const devices = sqliteTable('devices', {
  token:        text('token').primaryKey(),
  registeredAt: integer('registered_at').notNull(),
});

export const lineSubscriptions = sqliteTable('line_subscriptions', {
  token:   text('token').notNull().references(() => devices.token, { onDelete: 'cascade' }),
  lineNum: text('line_num').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.token, t.lineNum] }),
}));

export const prevStatus = sqliteTable('prev_status', {
  lineNum:   text('line_num').primaryKey(),
  status:    text('status').notNull(),
  note:      text('note'),
  updatedAt: integer('updated_at').notNull(),
});

export const webPushSubscriptions = sqliteTable('web_push_subscriptions', {
  endpoint:    text('endpoint').primaryKey(),
  p256dh:      text('p256dh').notNull(),
  auth:        text('auth').notNull(),
  registeredAt: integer('registered_at').notNull(),
});

export const webPushLineSubscriptions = sqliteTable('web_push_line_subscriptions', {
  endpoint: text('endpoint').notNull().references(() => webPushSubscriptions.endpoint, { onDelete: 'cascade' }),
  lineNum:  text('line_num').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.endpoint, t.lineNum] }),
}));
