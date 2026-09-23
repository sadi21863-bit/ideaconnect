import { db } from "@/db";
import {
  ideas,
  ideaComments,
  aiLabArchives,
  agentMemories,
} from "@/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { ALL_AGENTS, type Agent } from "./personas";

const AI_LAB_ROOM_ID = process.env.AI_LAB_ROOM_ID ?? "";

export interface AgentProfileStats {
  ideasPosted: number;
  commentsPosted: number;
  debatesWon: number;
  memoriesKept: number;
}

export interface AgentProfileIdea {
  id: string;
  title: string;
  createdAt: Date | null;
}

export interface AgentProfileComment {
  id: string;
  ideaId: string;
  ideaTitle: string;
  excerpt: string;
  createdAt: Date | null;
}

export interface AgentProfileWin {
  id: string;
  date: string;
  theme: string;
}

export interface AgentProfile {
  agent: Agent;
  stats: AgentProfileStats;
  recentIdeas: AgentProfileIdea[];
  recentComments: AgentProfileComment[];
  recentWins: AgentProfileWin[];
}

async function countIdeas(agentId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(ideas)
    .where(and(eq(ideas.userId, agentId), eq(ideas.roomId, AI_LAB_ROOM_ID)));
  return row?.n ?? 0;
}

async function countComments(agentId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(ideaComments)
    .where(eq(ideaComments.userId, agentId));
  return row?.n ?? 0;
}

async function countMemories(agentId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(agentMemories)
    .where(eq(agentMemories.agentId, agentId));
  return row?.n ?? 0;
}

/** Full public profile for one agent by handle. Returns null for unknown handles. */
export async function getAgentProfile(handle: string): Promise<AgentProfile | null> {
  const agent = ALL_AGENTS.find((a) => a.handle === handle);
  if (!agent) return null;

  const [ideasPosted, commentsPosted, memoriesKept, wonArchives] = await Promise.all([
    countIdeas(agent.id),
    countComments(agent.id),
    countMemories(agent.id),
    db
      .select({ id: aiLabArchives.id, date: aiLabArchives.date, theme: aiLabArchives.theme })
      .from(aiLabArchives)
      .where(eq(aiLabArchives.winnerAgentId, agent.id))
      .orderBy(desc(aiLabArchives.date)),
  ]);

  const recentIdeas = await db
    .select({ id: ideas.id, title: ideas.title, createdAt: ideas.createdAt })
    .from(ideas)
    .where(and(eq(ideas.userId, agent.id), eq(ideas.roomId, AI_LAB_ROOM_ID)))
    .orderBy(desc(ideas.createdAt))
    .limit(5);

  const recentComments = await db
    .select({
      id: ideaComments.id,
      ideaId: ideaComments.ideaId,
      content: ideaComments.content,
      createdAt: ideaComments.createdAt,
      ideaTitle: ideas.title,
    })
    .from(ideaComments)
    .leftJoin(ideas, eq(ideaComments.ideaId, ideas.id))
    .where(eq(ideaComments.userId, agent.id))
    .orderBy(desc(ideaComments.createdAt))
    .limit(5);

  return {
    agent,
    stats: {
      ideasPosted,
      commentsPosted,
      debatesWon: wonArchives.length,
      memoriesKept,
    },
    recentIdeas: recentIdeas.map((r) => ({
      id: String(r.id),
      title: String(r.title ?? "(untitled)"),
      createdAt: r.createdAt ? new Date(r.createdAt) : null,
    })),
    recentComments: recentComments.map((r) => ({
      id: String(r.id),
      ideaId: String(r.ideaId ?? ""),
      ideaTitle: String(r.ideaTitle ?? "(unknown idea)"),
      excerpt: String(r.content ?? "").slice(0, 160),
      createdAt: r.createdAt ? new Date(r.createdAt) : null,
    })),
    recentWins: wonArchives.slice(0, 5).map((r) => ({
      id: String(r.id),
      date: String(r.date),
      theme: String(r.theme ?? ""),
    })),
  };
}
