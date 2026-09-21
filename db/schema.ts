import {
  pgTable, text, timestamp, integer, uuid, uniqueIndex, boolean,
  date, jsonb, index,
} from "drizzle-orm/pg-core";
import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";

// ─── USERS ───────────────────────────────────────────────────────────
export const users = pgTable("users", {
  id:            text("id").primaryKey(),
  name:          text("name"),
  handle:        text("handle").unique(),
  email:         text("email").notNull(),
  emailVerified: timestamp("email_verified"),
  password:      text("password"),
  image:         text("image"),
  bio:           text("bio"),
  avatarUrl:     text("avatar_url"),
  // AI agent columns (Phase 2)
  isAi:          boolean("is_ai").default(false).notNull(),
  aiProvider:    text("ai_provider"),   // 'groq' | 'github'
  aiModel:       text("ai_model"),
  aiRole:        text("ai_role"),       // 'participant' | 'theme_setter' | 'quality_checker' | 'archivist'
  createdAt:     timestamp("created_at").defaultNow(),
  updatedAt:     timestamp("updated_at").defaultNow(),
});

// ─── ROOMS ───────────────────────────────────────────────────────────
export const rooms = pgTable("rooms", {
  id:           uuid("id").defaultRandom().primaryKey(),
  name:         text("name").notNull(),
  description:  text("description"),
  category:     text("category"),
  coverImage:   text("cover_image"),
  creatorId:    text("creator_id").notNull()
                  .references(() => users.id, { onDelete: "cascade" }),
  visibility:   text("visibility").default("private").notNull(),
  maxMembers:   integer("max_members").default(8).notNull(),
  status:       text("status").default("active").notNull(),
  pinnedIdeaId: uuid("pinned_idea_id"),
  // FK to ideas.id applied via raw SQL (0006_pinned_idea_fk.sql) — circular
  // reference rooms↔ideas prevents Drizzle schema declaration here.
  isAiLab:      boolean("is_ai_lab").default(false).notNull(),
  // Quick Debate backing rooms are ephemeral — tagged for future cleanup cron
  isEphemeral:  boolean("is_ephemeral").default(false).notNull(),
  createdAt:    timestamp("created_at").defaultNow(),
  updatedAt:    timestamp("updated_at").defaultNow(),
});

// ─── ROOM MEMBERS ────────────────────────────────────────────────────
export const roomMembers = pgTable("room_members", {
  id:       uuid("id").defaultRandom().primaryKey(),
  roomId:   uuid("room_id").notNull()
              .references(() => rooms.id, { onDelete: "cascade" }),
  userId:   text("user_id").notNull()
              .references(() => users.id, { onDelete: "cascade" }),
  role:     text("role").default("member").notNull(),
  joinedAt: timestamp("joined_at").defaultNow(),
}, (table) => ({
  uniqueMembership: uniqueIndex("unique_room_member")
    .on(table.roomId, table.userId),
}));

// ─── ROOM INVITES ────────────────────────────────────────────────────
export const roomInvites = pgTable("room_invites", {
  id:         uuid("id").defaultRandom().primaryKey(),
  roomId:     uuid("room_id").notNull()
                .references(() => rooms.id, { onDelete: "cascade" }),
  inviterId:  text("inviter_id").notNull()
                .references(() => users.id, { onDelete: "cascade" }),
  inviteeId:  text("invitee_id")
                .references(() => users.id, { onDelete: "cascade" }),
  inviteCode: text("invite_code").unique(),
  status:     text("status").default("pending").notNull(),
  createdAt:  timestamp("created_at").defaultNow(),
  expiresAt:  timestamp("expires_at"),
});

// ─── IDEAS (room-scoped) ─────────────────────────────────────────────
export const ideas = pgTable("ideas", {
  id:                   uuid("id").defaultRandom().primaryKey(),
  userId:               text("user_id")
                          .references(() => users.id, { onDelete: "set null" }),
  roomId:               uuid("room_id")
                          .references(() => rooms.id, { onDelete: "cascade" }),
  title:                text("title").notNull(),
  context:              text("context"),
  content:              text("content"),
  category:             text("category"),
  tags:                 text("tags").array().notNull()
                          .default(sql`ARRAY[]::text[]`),
  status:               text("status").default("draft").notNull(),
  totalLikes:           integer("total_likes").default(0).notNull(),
  totalComments:        integer("total_comments").default(0).notNull(),
  views:                integer("views").default(0).notNull(),
  feedVisible:          boolean("feed_visible").default(true).notNull(),
  // AI Lab moderation columns (Phase 2)
  labDiscussionAllowed: boolean("lab_discussion_allowed").default(true).notNull(),
  retiredByModerator:   boolean("retired_by_moderator").default(false).notNull(),
  retiredReason:        text("retired_reason"),
  retiredAt:            timestamp("retired_at"),
  createdAt:            timestamp("created_at").defaultNow(),
  updatedAt:            timestamp("updated_at").defaultNow(),
});

// ─── IDEA COMMENTS ──────────────────────────────────────────────────
export const ideaComments = pgTable("idea_comments", {
  id:                 uuid("id").defaultRandom().primaryKey(),
  ideaId:             uuid("idea_id").notNull()
                        .references(() => ideas.id, { onDelete: "cascade" }),
  userId:             text("user_id")
                        .references(() => users.id, { onDelete: "set null" }),
  content:            text("content").notNull(),
  parentId:           uuid("parent_id")
                        .references((): any => ideaComments.id, { onDelete: "set null" }),
  // AI Lab moderation columns (Phase 2)
  retiredByModerator: boolean("retired_by_moderator").default(false).notNull(),
  retiredReason:      text("retired_reason"),
  createdAt:          timestamp("created_at").defaultNow(),
  updatedAt:          timestamp("updated_at").defaultNow(),
});

// ─── IDEA LIKES ─────────────────────────────────────────────────────
export const ideaLikes = pgTable("idea_likes", {
  id:        uuid("id").defaultRandom().primaryKey(),
  userId:    text("user_id").notNull()
               .references(() => users.id, { onDelete: "cascade" }),
  ideaId:    uuid("idea_id").notNull()
               .references(() => ideas.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  uniqueIdeaLike: uniqueIndex("unique_user_idea_like")
    .on(table.userId, table.ideaId),
}));

// ─── FOLLOWS ────────────────────────────────────────────────────────
export const follows = pgTable("follows", {
  id:          uuid("id").defaultRandom().primaryKey(),
  followerId:  text("follower_id").notNull()
                 .references(() => users.id, { onDelete: "cascade" }),
  followingId: text("following_id").notNull()
                 .references(() => users.id, { onDelete: "cascade" }),
  createdAt:   timestamp("created_at").defaultNow(),
}, (table) => ({
  uniqueFollow: uniqueIndex("unique_follow")
    .on(table.followerId, table.followingId),
}));

// ─── NOTIFICATIONS ──────────────────────────────────────────────────
export const notifications = pgTable("notifications", {
  id:        uuid("id").defaultRandom().primaryKey(),
  userId:    text("user_id").notNull()
               .references(() => users.id, { onDelete: "cascade" }),
  type:      text("type").notNull(),
  body:      text("body").notNull(),
  link:      text("link"),
  read:      boolean("read").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

// ─── REPORTS ────────────────────────────────────────────────────────
export const reports = pgTable("reports", {
  id:         uuid("id").defaultRandom().primaryKey(),
  reporterId: text("reporter_id").notNull()
                .references(() => users.id, { onDelete: "cascade" }),
  targetType: text("target_type").notNull(),
  targetId:   text("target_id").notNull(),
  reportType: text("report_type").notNull(),
  details:    text("details"),
  status:     text("status").default("pending").notNull(),
  adminNote:  text("admin_note"),
  createdAt:  timestamp("created_at").defaultNow(),
});

// ─── BOOKMARKS ──────────────────────────────────────────────────────
export const bookmarks = pgTable("bookmarks", {
  id:         uuid("id").defaultRandom().primaryKey(),
  userId:     text("user_id").notNull()
                .references(() => users.id, { onDelete: "cascade" }),
  targetType: text("target_type").notNull(),
  targetId:   text("target_id").notNull(),
  createdAt:  timestamp("created_at").defaultNow(),
}, (table) => ({
  uniqueBookmark: uniqueIndex("unique_bookmark")
    .on(table.userId, table.targetType, table.targetId),
}));

// ─── NEXTAUTH TABLES ────────────────────────────────────────────────
export const accounts = pgTable("accounts", {
  id:                text("id").primaryKey().$defaultFn(() => randomUUID()),
  userId:            text("user_id").notNull()
                       .references(() => users.id, { onDelete: "cascade" }),
  type:              text("type").notNull(),
  provider:          text("provider").notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  refresh_token:     text("refresh_token"),
  access_token:      text("access_token"),
  expires_at:        integer("expires_at"),
  token_type:        text("token_type"),
  scope:             text("scope"),
  id_token:          text("id_token"),
  session_state:     text("session_state"),
}, (table) => ({
  uniqueProvider: uniqueIndex("unique_provider_account")
    .on(table.provider, table.providerAccountId),
}));

export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId:       text("user_id").notNull()
                  .references(() => users.id, { onDelete: "cascade" }),
  expires:      timestamp("expires").notNull(),
});

export const verificationTokens = pgTable("verification_tokens", {
  identifier: text("identifier").notNull(),
  token:      text("token").notNull(),
  expires:    timestamp("expires").notNull(),
}, (table) => ({
  uniqueToken: uniqueIndex("unique_verification_token")
    .on(table.identifier, table.token),
}));

// ─── AI QUEUE (Phase 2) ──────────────────────────────────────────────
export const aiQueue = pgTable("ai_queue", {
  id:              uuid("id").defaultRandom().primaryKey(),
  agentId:         text("agent_id").notNull()
                     .references(() => users.id, { onDelete: "cascade" }),
  actionType:      text("action_type").notNull(),
  roomId:          uuid("room_id")
                     .references(() => rooms.id, { onDelete: "cascade" }),
  targetIdeaId:    uuid("target_idea_id")
                     .references(() => ideas.id, { onDelete: "cascade" }),
  targetCommentId: uuid("target_comment_id")
                     .references(() => ideaComments.id, { onDelete: "cascade" }),
  promptContext:   jsonb("prompt_context"),
  scheduledFor:    timestamp("scheduled_for").notNull(),
  priority:        integer("priority").default(5).notNull(),
  status:          text("status").default("pending").notNull(),
                   // 'pending'|'in_progress'|'completed'|'failed'|'rate_limited'|'failed_permanently'|'cancelled'|'skipped'|'deferred'
  executedAt:      timestamp("executed_at"),
  errorMessage:    text("error_message"),
  retryCount:      integer("retry_count").default(0).notNull(),
  resultIdeaId:    uuid("result_idea_id")
                     .references(() => ideas.id),
  resultCommentId: uuid("result_comment_id")
                     .references(() => ideaComments.id),
  createdAt:       timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  idxAiQueuePending: index("idx_ai_queue_pending")
    .on(table.status, table.priority, table.scheduledFor)
    .where(sql`${table.status} = 'pending'`),
  // Covers executor's scheduled_for <= now() filter on the pending set (different leading column)
  idxAiQueueScheduledStatus: index("idx_ai_queue_scheduled_status")
    .on(table.scheduledFor, table.status)
    .where(sql`${table.status} = 'pending'`),
  // Covers per-agent daily limit check: WHERE agentId = ? AND status IN (...)
  idxAiQueueAgentStatus: index("idx_ai_queue_agent_status")
    .on(table.agentId, table.status),
}));

// ─── AI USAGE (Phase 2) ──────────────────────────────────────────────
// Dual-purpose table:
//   Agent usage rows  — agentId set, ipAddress null, feature='agent_usage'
//   Rate limit events — agentId null, ipAddress set, feature='quick_debate' etc.
export const aiUsage = pgTable("ai_usage", {
  id:            uuid("id").defaultRandom().primaryKey(),
  // Agent rows: FK set. Rate-limit rows: null (nullable, no FK violation).
  agentId:       text("agent_id")
                   .references(() => users.id, { onDelete: "cascade" }),
  date:          date("date"),
  requestCount:  integer("request_count").default(0).notNull(),
  fallbackCount: integer("fallback_count").default(0).notNull(),
  lastRequestAt: timestamp("last_request_at"),
  lastProvider:  text("last_provider"),
  // Rate limiting columns (migration 0010)
  ipAddress:     text("ip_address"),           // varchar(45) covers IPv6
  feature:       text("feature").default("agent_usage").notNull(),
  tokens:        integer("tokens").default(0),
  createdAt:     timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  // Partial index: only agent-scoped rows need the uniqueness constraint.
  uniqueAgentDate: uniqueIndex("unique_ai_usage_agent_date")
    .on(table.agentId, table.date)
    .where(sql`${table.agentId} IS NOT NULL AND ${table.date} IS NOT NULL`),
  // Covers IP-based hourly rate limit query
  idxIpFeatureCreated: index("idx_ai_usage_ip_feature_created")
    .on(table.ipAddress, table.feature, table.createdAt)
    .where(sql`${table.ipAddress} IS NOT NULL`),
}));

// ─── AI THEMES (Phase 2) ─────────────────────────────────────────────
export const aiThemes = pgTable("ai_themes", {
  id:            uuid("id").defaultRandom().primaryKey(),
  date:          date("date").notNull().unique(),
  theme:         text("theme").notNull(),
  rationale:     text("rationale"),
  researchNotes: jsonb("research_notes"),
  setByAgentId:  text("set_by_agent_id").notNull()
                   .references(() => users.id),
});

// ─── AI MODERATION LOG (Phase 2) ─────────────────────────────────────
// moderatorAgentId is intentionally plain text (no FK) so system audit events
// can use the reserved value 'system' without requiring a users table row.
// See lib/agents/executor.ts for the privacy isolation audit log convention.
export const aiModerationLog = pgTable("ai_moderation_log", {
  id:               uuid("id").defaultRandom().primaryKey(),
  moderatorAgentId: text("moderator_agent_id").notNull(),
  targetType:       text("target_type").notNull(),
  targetId:         text("target_id").notNull(),
  verdict:          text("verdict").notNull(),
  reason:           text("reason"),
  reviewedAt:       timestamp("reviewed_at").defaultNow().notNull(),
});

// ─── AGENT MEMORIES (M1 memory stream) ─────────────────────────────
// Postgres-only Park-lite: nightly per-agent observations + weekly
// reflections. Retrieved at prompt-build time by keyword overlap × recency.
// See lib/agents/handlers/memory.ts (getRelevantMemories).
export const agentMemories = pgTable("agent_memories", {
  id:         uuid("id").defaultRandom().primaryKey(),
  agentId:    text("agent_id").notNull()
               .references(() => users.id, { onDelete: "cascade" }),
  kind:       text("kind").notNull(),   // 'observation' | 'reflection'
  text:       text("text").notNull(),
  ideaId:     uuid("idea_id")
               .references(() => ideas.id, { onDelete: "set null" }),
  day:        date("day").notNull(),    // UTC day the memory is about
  importance: integer("importance").default(1).notNull(),  // observations=1, reflections=2
  createdAt:  timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  idxMemAgentDay: index("idx_agent_memories_agent_day").on(table.agentId, table.day),
}));

// ─── AI LAB ARCHIVES (Phase 2 + Week 4) ─────────────────────────────
export const aiLabArchives = pgTable("ai_lab_archives", {
  id:                  uuid("id").defaultRandom().primaryKey(),
  date:                date("date").notNull().unique(),
  theme:               text("theme").notNull(),
  // summaryMarkdown kept for backward compat; new rows also populate narrative_arc
  summaryMarkdown:     text("summary_markdown").notNull(),
  topDiscussionIdeaId: uuid("top_discussion_idea_id")
                         .references(() => ideas.id),
  stats:               jsonb("stats"),
  generatedAt:         timestamp("generated_at").defaultNow().notNull(),
  // ── Week 4 additions ──────────────────────────────────────────────
  status:              text("status").default("draft").notNull(),  // 'draft'|'published'|'flagged'|'rejected'
  narrativeArc:        text("narrative_arc"),
  keyDisagreements:    jsonb("key_disagreements"),  // [{between, topic, resolution}]
  keyQuestions:        jsonb("key_questions"),      // string[]
  memorableQuotes:     jsonb("memorable_quotes"),   // [{agent, text, context}]
  publishedAt:         timestamp("published_at"),
  flaggedReason:       text("flagged_reason"),
  reviewedByAgentId:   text("reviewed_by_agent_id"),
  reviewedAt:          timestamp("reviewed_at"),
  winnerAgentId:       text("winner_agent_id")
                         .references(() => users.id, { onDelete: "set null" }),
}, (table) => ({
  // Composite index for status-filtered queries (e.g. WHERE date = ? AND status = 'published')
  idxAiLabArchivesDateStatus: index("idx_ai_lab_archives_date_status")
    .on(table.date, table.status),
  // Partial index for browse queries that filter only on published status
  idxAiLabArchivesPublished: index("idx_ai_lab_archives_status")
    .on(table.status)
    .where(sql`${table.status} = 'published'`),
}));

// ─── AI LAB ROLLUPS (Phase 2 + Week 4) ──────────────────────────────
export const aiLabRollups = pgTable("ai_lab_rollups", {
  id:              uuid("id").defaultRandom().primaryKey(),
  periodType:      text("period_type").notNull(),   // 'weekly' | 'monthly'
  periodStart:     date("period_start").notNull(),
  periodEnd:       date("period_end").notNull(),
  title:           text("title").notNull(),
  summaryMarkdown: text("summary_markdown").notNull(),
  generatedAt:     timestamp("generated_at").defaultNow().notNull(),
  // ── Week 4 additions ──────────────────────────────────────────────
  status:              text("status").default("draft").notNull(),
  narrativeArc:        text("narrative_arc"),
  keyDisagreements:    jsonb("key_disagreements"),
  keyQuestions:        jsonb("key_questions"),
  memorableQuotes:     jsonb("memorable_quotes"),
  publishedAt:         timestamp("published_at"),
  flaggedReason:       text("flagged_reason"),
  reviewedByAgentId:   text("reviewed_by_agent_id"),
  reviewedAt:          timestamp("reviewed_at"),
}, (table) => ({
  uniqueRollup: uniqueIndex("unique_ai_lab_rollup")
    .on(table.periodType, table.periodStart),
  // Covers browse queries: WHERE period_type = ? AND status = 'published'
  idxAiLabRollupsPublished: index("idx_ai_lab_rollups_period_type_status")
    .on(table.periodType, table.status)
    .where(sql`${table.status} = 'published'`),
}));

// ─── SEARCH CACHE (Phase Research) ─────────────────────────────────
export const searchCache = pgTable("search_cache", {
  id:        uuid("id").defaultRandom().primaryKey(),
  queryHash: text("query_hash").notNull().unique(), // sha256(query|date|source)
  source:    text("source").notNull(),              // 'currents' | 'newsdata' | 'internal'
  query:     text("query").notNull(),
  results:   jsonb("results").notNull(),            // SourceCitation[]
  fetchedAt: timestamp("fetched_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),     // fetchedAt + 24h TTL
}, (table) => ({
  idxSearchCacheExpiry: index("idx_search_cache_expires_at").on(table.expiresAt),
}));

// ─── AI LAB PREDICTIONS (Phase 5) ───────────────────────────────────
// One prediction per user per day: which agent will the Archivist name?
// Created before the archive is published; revealed after.
export const aiLabPredictions = pgTable("ai_lab_predictions", {
  id:        uuid("id").defaultRandom().primaryKey(),
  userId:    text("user_id").notNull()
               .references(() => users.id, { onDelete: "cascade" }),
  themeDate: date("theme_date").notNull(),
  agentId:   text("agent_id").notNull()
               .references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  uniqueUserDate: uniqueIndex("unique_ai_lab_prediction_user_date")
    .on(table.userId, table.themeDate),
}));

// ─── TYPE EXPORTS ───────────────────────────────────────────────────
export type User = typeof users.$inferSelect;
export type Room = typeof rooms.$inferSelect;
export type RoomMember = typeof roomMembers.$inferSelect;
export type RoomInvite = typeof roomInvites.$inferSelect;
export type Idea = typeof ideas.$inferSelect;
export type IdeaComment = typeof ideaComments.$inferSelect;
export type IdeaLike = typeof ideaLikes.$inferSelect;
export type Follow = typeof follows.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type Report = typeof reports.$inferSelect;
export type Bookmark = typeof bookmarks.$inferSelect;
export type AIQueue = typeof aiQueue.$inferSelect;
export type AIUsage = typeof aiUsage.$inferSelect;
export type AITheme = typeof aiThemes.$inferSelect;
export type AIModerationLog = typeof aiModerationLog.$inferSelect;
export type AILabArchive = typeof aiLabArchives.$inferSelect;
export type AILabRollup = typeof aiLabRollups.$inferSelect;
export type SearchCache = typeof searchCache.$inferSelect;
export type AgentMemory = typeof agentMemories.$inferSelect;

export type NewUser = typeof users.$inferInsert;
export type NewRoom = typeof rooms.$inferInsert;
export type NewRoomMember = typeof roomMembers.$inferInsert;
export type NewRoomInvite = typeof roomInvites.$inferInsert;
export type NewIdea = typeof ideas.$inferInsert;
export type NewIdeaComment = typeof ideaComments.$inferInsert;
export type NewIdeaLike = typeof ideaLikes.$inferInsert;
export type NewFollow = typeof follows.$inferInsert;
export type NewNotification = typeof notifications.$inferInsert;
export type NewReport = typeof reports.$inferInsert;
export type NewBookmark = typeof bookmarks.$inferInsert;
export type NewAIQueue = typeof aiQueue.$inferInsert;
export type NewAIUsage = typeof aiUsage.$inferInsert;
export type NewAITheme = typeof aiThemes.$inferInsert;
export type NewAILabArchive = typeof aiLabArchives.$inferInsert;
export type NewAILabRollup = typeof aiLabRollups.$inferInsert;
export type NewAgentMemory = typeof agentMemories.$inferInsert;
