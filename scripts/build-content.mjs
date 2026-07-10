// Builds content.json for the top1server launcher from Discord forum channels.
//
// Reads two Discord forum channels (news + devblog) via the REST API and turns each
// thread into a launcher card: thread name -> title, first post -> summary, applied
// tag -> category/build, creation time -> date, thread link -> url. Writes the result
// into content.json, REPLACING only `news` and `devblog` — `banner` and `shop` are kept
// from the existing file (they have no Discord source and are edited by hand).
//
// No dependencies: Node 18+ global fetch. Runs in .github/workflows/sync-content.yml.
// Safe no-op until configured: if the token / ids are missing it logs and exits 0, so a
// scheduled run is green (never a red failure) before the owner wires up the secrets.
//
// Setup + the exact secrets/variables it expects: ../CONTENT-AUTOMATION.md

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const API = "https://discord.com/api/v10";
const DISCORD_EPOCH = 1420070400000n;

const cfg = {
  token: process.env.DISCORD_TOKEN || "",
  guildId: process.env.GUILD_ID || "",
  newsChannelId: process.env.NEWS_CHANNEL_ID || "",
  devblogChannelId: process.env.DEVBLOG_CHANNEL_ID || "",
  newsLimit: intEnv("NEWS_LIMIT", 12),
  devblogLimit: intEnv("DEVBLOG_LIMIT", 8),
  summaryMax: intEnv("SUMMARY_MAX", 200),
  file: process.env.CONTENT_FILE || "content.json",
};

function intEnv(name, def) {
  const n = parseInt(process.env[name] || "", 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Discord REST (with 429 back-off) -------------------------------------------------------

async function dfetch(pathname) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(API + pathname, {
      headers: {
        Authorization: `Bot ${cfg.token}`,
        "User-Agent": "top1server-content (github-actions, 1.0)",
      },
    });
    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      const waitMs = Math.ceil((Number(body.retry_after) || 1) * 1000) + 300;
      console.warn(`rate limited on ${pathname}; retrying in ${waitMs}ms`);
      await sleep(waitMs);
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Discord ${res.status} ${res.statusText} on ${pathname} ${text}`.trim());
    }
    return res.json();
  }
  throw new Error(`repeatedly rate limited on ${pathname}`);
}

// All active threads in the guild that belong to `channelId`, plus a page of archived ones.
async function collectThreads(channelId) {
  const byId = new Map();
  let activeMatch = 0, archivedCount = 0;

  const active = await dfetch(`/guilds/${cfg.guildId}/threads/active`);
  for (const t of active.threads || []) {
    if (t.parent_id === channelId) { byId.set(t.id, t); activeMatch++; }
  }

  try {
    const archived = await dfetch(`/channels/${channelId}/threads/archived/public?limit=30`);
    for (const t of archived.threads || []) { byId.set(t.id, t); archivedCount++; }
  } catch (e) {
    console.warn(`  archived threads unavailable for ${channelId}: ${e.message}`);
  }

  console.log(`  threads: active(matching)=${activeMatch}, archived=${archivedCount}, total=${byId.size}`);
  return [...byId.values()];
}

// First post of a thread as a teaser. Forum posts: the starter message shares the thread id
// (one fast GET). Fallback: the oldest message actually inside the thread (works for threads
// whose parent is a text channel, where id != any in-thread message). Empty when nothing is
// readable or the bot lacks the Message Content intent (title/date/tag still work regardless).
async function starterSummary(threadId) {
  try {
    const msg = await dfetch(`/channels/${threadId}/messages/${threadId}`);
    return truncate(plainText(msg.content || ""), cfg.summaryMax);
  } catch {
    // not a forum-style starter — fall through to the oldest in-thread message
  }
  try {
    const msgs = await dfetch(`/channels/${threadId}/messages?after=0&limit=1`);
    if (Array.isArray(msgs) && msgs.length) {
      const first = msgs.reduce((a, b) => (BigInt(a.id) <= BigInt(b.id) ? a : b));
      return truncate(plainText(first.content || ""), cfg.summaryMax);
    }
  } catch (e) {
    console.warn(`  no starter message for ${threadId}: ${e.message}`);
  }
  return "";
}

// --- Pure helpers (exported for the unit test) ----------------------------------------------

export function snowflakeToISO(id) {
  const ms = (BigInt(id) >> 22n) + DISCORD_EPOCH;
  return new Date(Number(ms)).toISOString();
}

export function threadDate(t) {
  const created = t.thread_metadata?.create_timestamp;
  return created ? new Date(created).toISOString() : snowflakeToISO(t.id);
}

// Canonical news category so the launcher shows a COLOURED badge. Owner may name the forum
// tag in Russian or English; anything unknown passes through (the launcher greys it).
export function mapCategory(tagName) {
  const k = (tagName || "").trim().toLowerCase();
  if (["update", "обновление", "апдейт", "патч"].includes(k)) return "update";
  if (["event", "ивент", "событие", "эвент"].includes(k)) return "event";
  if (["maintenance", "техработы", "обслуживание", "тех.работы"].includes(k)) return "maintenance";
  return (tagName || "").trim(); // unknown tag -> verbatim (grey fallback), "" -> generic
}

// Discord markdown -> a plain-text teaser.
export function plainText(md) {
  let s = String(md || "");
  s = s.replace(/```[\s\S]*?```/g, " ");           // fenced code
  s = s.replace(/`([^`]+)`/g, "$1");                // inline code
  s = s.replace(/<a?:(\w+):\d+>/g, ":$1:");         // custom emoji -> :name:
  s = s.replace(/<@[!&]?\d+>/g, "");                // user/role mentions
  s = s.replace(/<#\d+>/g, "");                     // channel mentions
  s = s.replace(/\|\|([^|]+)\|\|/g, "$1");          // spoilers
  s = s.replace(/~~([^~]+)~~/g, "$1");              // strikethrough
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");          // bold
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1$2");    // italic *
  s = s.replace(/__([^_]+)__/g, "$1");              // underline
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");    // [text](url) -> text
  s = s.replace(/^\s*>\s?/gm, "");                  // block quotes
  s = s.replace(/^\s*#{1,3}\s+/gm, "");             // headings
  s = s.replace(/\s+/g, " ").trim();                // collapse whitespace
  return s;
}

export function truncate(s, max) {
  s = String(s || "");
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}

const newest = (a, b) => (threadDate(a) < threadDate(b) ? 1 : -1);

// --- Build one feed -------------------------------------------------------------------------

async function buildFeed(channelId, limit, kind /* "news" | "devblog" */) {
  if (!channelId) return [];
  const channel = await dfetch(`/channels/${channelId}`);
  const tags = new Map((channel.available_tags || []).map((t) => [t.id, t.name]));
  console.log(`${kind}: "${channel.name}" type=${channel.type} (15=forum), forum-tags=${tags.size}`);
  const threads = await collectThreads(channelId);
  const top = threads.sort(newest).slice(0, limit);

  const items = [];
  for (const t of top) {
    const firstTag = (t.applied_tags || [])[0];
    const tagName = firstTag ? tags.get(firstTag) || "" : "";
    const base = {
      id: t.id,
      date: threadDate(t),
      title: (t.name || "").trim(),
      summary: await starterSummary(t.id),
      url: `https://discord.com/channels/${cfg.guildId}/${t.id}`,
    };
    items.push(kind === "devblog"
      ? { id: base.id, build: tagName.trim(), date: base.date, title: base.title, summary: base.summary, url: base.url }
      : { id: base.id, date: base.date, category: mapCategory(tagName), title: base.title, summary: base.summary, url: base.url });
  }
  return items;
}

// --- Main -----------------------------------------------------------------------------------

async function loadExisting(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return {}; // missing / malformed -> start fresh (banner/shop simply won't be preserved)
  }
}

async function main() {
  if (!cfg.token || !cfg.newsChannelId) {
    console.log("Discord content sync not configured (need DISCORD_TOKEN and NEWS_CHANNEL_ID) — skipping.");
    return;
  }

  // GUILD_ID is optional: derive it from the news channel when not supplied, so the owner
  // never has to hunt down the server id (a channel belongs to exactly one guild).
  if (!cfg.guildId) {
    const ch = await dfetch(`/channels/${cfg.newsChannelId}`);
    cfg.guildId = ch.guild_id || "";
    if (!cfg.guildId) throw new Error("could not resolve guild id from NEWS_CHANNEL_ID");
    console.log(`Resolved GUILD_ID ${cfg.guildId} from the news channel.`);
  }

  const existing = await loadExisting(cfg.file);

  const [news, devblog] = await Promise.all([
    buildFeed(cfg.newsChannelId, cfg.newsLimit, "news"),
    buildFeed(cfg.devblogChannelId, cfg.devblogLimit, "devblog"),
  ]);

  // Preserve everything the file already had; overwrite only the two Discord-sourced feeds.
  const out = { ...existing, news, devblog };
  // Keep a stable key order for a clean diff: banner, news, devblog, shop.
  const ordered = {};
  if (out.banner !== undefined) ordered.banner = out.banner;
  ordered.news = out.news;
  ordered.devblog = out.devblog;
  if (out.shop !== undefined) ordered.shop = out.shop;
  for (const k of Object.keys(out)) if (!(k in ordered)) ordered[k] = out[k]; // carry any extras (e.g. _comment)

  await writeFile(cfg.file, JSON.stringify(ordered, null, 2) + "\n", "utf8");
  console.log(`Wrote ${cfg.file}: ${news.length} news, ${devblog.length} devblog.`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(e.stack || String(e));
    process.exit(1);
  });
}
