import type { Ctx } from "./bot.js";

export type Status = "published" | "pending" | "removed" | "sold";
export interface Listing {
  id: string; owner: number; title: string; description: string; photos: string[];
  category: string; price?: string; location: string;
  contact: "telegram" | "phone"; phone?: string; status: Status;
  pinned: boolean; createdAt: number; updatedAt: number;
  authorName?: string; ownerDeleted?: boolean;
  /** Optional vector produced by the configured embedding service. */
  embedding?: number[];
}
export interface Report { id: string; listingId: string; reporter: number; reason: string; comment?: string; createdAt: number; }
export type ReviewStatus = "pending" | "approved" | "rejected";
export interface UserProfile {
  userId: number; displayName: string; avatarFileId?: string; neighbourhood?: string;
  avatarThumbnailFileId?: string; avatarCrop?: "centered-circle";
  bio?: string; profileVideoFileId?: string; avgRating: number; totalReviews: number;
  createdAt: number; updatedAt: number;
}
export interface UserReview {
  id: string; reviewerId: number; targetUserId: number; rating: number; text?: string;
  videoFileId?: string; status: ReviewStatus; flaggedCount: number; createdAt: number; updatedAt: number;
}
export interface Domain {
  listings: Listing[];
  reports: Report[];
  history: Array<{ listingId: string; action: string; by: number | string; at: number; reason?: string }>;
  banned: number[];
  saved: Array<{ user: number; listing: string }>;
  users?: Array<{ id: number; username?: string; displayName?: string; phone?: string; phoneVerified?: boolean; avatarFileId?: string; banned: boolean; joinedAt: number; firstListingSubmittedAt?: number }>;
  notificationQueue?: Array<{ kind: string; text: string; listingId?: string; createdAt: number }>;
  userProfiles?: UserProfile[];
  userReviews?: UserReview[];
  reviewAutoApprove?: boolean;
  neuralEnabled?: boolean;
  neuralRequests?: Array<{ user: number; at: number }>;
  neuralLogs?: Array<{ user: number; query: string; image: boolean; listingIds: string[]; at: number }>;
  browseEvents?: Array<{ user: number; event: "category" | "all_categories"; value?: string; at: number }>;
}

export const CATEGORIES = ["Товары", "Услуги", "Работа", "Жильё", "Авто", "События", "Сообщество", "Потеряно и найдено", "Другое"];
export const LOCATIONS = ["Вся Москва", "Центр", "Север", "Юг", "Восток", "Запад", "Северо-Восток", "Юго-Восток"];
// One clock seam keeps expiry/cutoff/status decisions deterministic. Production
// uses wall time; tests and replay tools can replace it without changing a
// handler's logic.
let currentClock: () => number = () => Date.now();
export const now = (): number => currentClock();
export function setClock(clock: (() => number) | undefined): void {
  currentClock = clock ?? (() => Date.now());
}
const empty = (): Domain => ({ listings: [], reports: [], history: [], banned: [], saved: [], users: [], notificationQueue: [] });

function normalize(value: Domain | undefined): Domain {
  const d = value ?? empty();
  return {
    listings: Array.isArray(d.listings) ? d.listings : [],
    reports: Array.isArray(d.reports) ? d.reports : [],
    history: Array.isArray(d.history) ? d.history : [],
    banned: Array.isArray(d.banned) ? d.banned : [],
    saved: Array.isArray(d.saved) ? d.saved : [],
    users: Array.isArray(d.users) ? d.users : [],
    notificationQueue: Array.isArray(d.notificationQueue) ? d.notificationQueue : [],
    userProfiles: Array.isArray(d.userProfiles) ? d.userProfiles : [],
    userReviews: Array.isArray(d.userReviews) ? d.userReviews : [],
    reviewAutoApprove: d.reviewAutoApprove === true,
    neuralEnabled: d.neuralEnabled !== false,
    neuralRequests: Array.isArray(d.neuralRequests) ? d.neuralRequests : [],
    neuralLogs: Array.isArray(d.neuralLogs) ? d.neuralLogs : [],
    browseEvents: Array.isArray(d.browseEvents) ? d.browseEvents : [],
  };
}

type RuntimeCtx = Ctx & { env?: { CHAT_DO?: { idFromName(name: string): unknown; get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> } } } };
async function readRemote(ctx: RuntimeCtx): Promise<Domain | undefined> {
  const ns = ctx.env?.CHAT_DO; if (!ns) return undefined;
  const stub = ns.get(ns.idFromName("domain:global"));
  const res = await stub.fetch("https://do/domain?key=state");
  return res.status === 204 ? empty() : normalize(await res.json() as Domain);
}
async function writeRemote(ctx: RuntimeCtx, value: Domain): Promise<boolean> {
  const ns = ctx.env?.CHAT_DO; if (!ns) return false;
  const stub = ns.get(ns.idFromName("domain:global"));
  await stub.fetch("https://do/domain", { method: "PUT", body: JSON.stringify({ key: "state", value }) });
  return true;
}
export async function loadDomain(ctx: RuntimeCtx): Promise<Domain> {
  const remote = await readRemote(ctx); if (remote) return remote;
  return normalize((ctx.session.domain ?? empty()) as unknown as Domain);
}
export async function saveDomain(ctx: RuntimeCtx, value: Domain): Promise<void> {
  if (!(await writeRemote(ctx, value))) ctx.session.domain = value as unknown as Record<string, unknown>;
}
export async function changeDomain<T>(ctx: RuntimeCtx, fn: (d: Domain) => T | Promise<T>): Promise<T> {
  const d = await loadDomain(ctx); const result = await fn(d); await saveDomain(ctx, d); return result;
}
export function queueNotification(d: Domain, kind: string, text: string, listingId?: string): void {
  (d.notificationQueue ??= []).push({ kind, text, listingId, createdAt: now() });
}
export function nextId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${prefix}-${uuid ?? String(now())}`;
}

/** Best-effort Telegram delivery. A blocked/deleted user must not abort a
 * moderation loop or hide the successful state change. */
export async function safeSend(ctx: Ctx, chatId: number | string, text: string): Promise<boolean> {
  try { await ctx.api.sendMessage(chatId, text); return true; } catch { return false; }
}
