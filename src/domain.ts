import type { Ctx } from "./bot.js";

export type Status = "published" | "pending" | "removed" | "sold";
export interface Listing {
  id: string; owner: number; title: string; description: string; photos: string[];
  category: string; price?: string; location: string;
  contact: "telegram" | "phone"; phone?: string; status: Status;
  pinned: boolean; createdAt: number; updatedAt: number;
}
export interface Report { id: string; listingId: string; reporter: number; reason: string; comment?: string; createdAt: number; }
export interface Domain { listings: Listing[]; reports: Report[]; history: Array<{ listingId: string; action: string; by: number | string; at: number; reason?: string }>; banned: number[]; saved: Array<{ user: number; listing: string }>; }

export const CATEGORIES = ["Товары", "Услуги", "Работа", "Жильё", "Авто", "События", "Сообщество", "Потеряно и найдено", "Другое"];
export const LOCATIONS = ["Вся Москва", "Центр", "Север", "Юг", "Восток", "Запад", "Северо-Восток", "Юго-Восток"];
export const now = (): number => Date.now();
const empty = (): Domain => ({ listings: [], reports: [], history: [], banned: [], saved: [] });

type RuntimeCtx = Ctx & { env?: { CHAT_DO?: { idFromName(name: string): unknown; get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> } } } };
async function readRemote(ctx: RuntimeCtx): Promise<Domain | undefined> {
  const ns = ctx.env?.CHAT_DO; if (!ns) return undefined;
  const stub = ns.get(ns.idFromName("domain:global"));
  const res = await stub.fetch("https://do/domain?key=state");
  return res.status === 204 ? empty() : (await res.json()) as Domain;
}
async function writeRemote(ctx: RuntimeCtx, value: Domain): Promise<boolean> {
  const ns = ctx.env?.CHAT_DO; if (!ns) return false;
  const stub = ns.get(ns.idFromName("domain:global"));
  await stub.fetch("https://do/domain", { method: "PUT", body: JSON.stringify({ key: "state", value }) });
  return true;
}
export async function loadDomain(ctx: RuntimeCtx): Promise<Domain> {
  const remote = await readRemote(ctx); if (remote) return remote;
  return ((ctx.session.domain ?? empty()) as unknown) as Domain;
}
export async function saveDomain(ctx: RuntimeCtx, value: Domain): Promise<void> {
  if (!(await writeRemote(ctx, value))) ctx.session.domain = value as unknown as Record<string, unknown>;
}
export async function changeDomain<T>(ctx: RuntimeCtx, fn: (d: Domain) => T | Promise<T>): Promise<T> {
  const d = await loadDomain(ctx); const result = await fn(d); await saveDomain(ctx, d); return result;
}
export function nextId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${prefix}-${uuid ?? String(now())}`;
}
