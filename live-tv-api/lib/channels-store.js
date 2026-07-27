// lib/channels-store.js
// Persists the user-configured list of YouTube channels (name + channel ID)
// that Live Event Monitor 1/2 and Katha Monitor pick from. Replaces the old
// hardcoded two-channel setup in youtube.js.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const CHANNEL_ID_PATTERN = /^UC[\w-]{22}$/;

function getBaseDir() {
  if (process.pkg) {
    return path.dirname(process.execPath);
  }
  try {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  } catch {
    return process.cwd();
  }
}

function getChannelsFile() {
  const dataDir = path.join(getBaseDir(), "data");
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return path.join(dataDir, "channels.json");
}

// No default channels — the user manages the full list via /api/channels.
const DEFAULT_CHANNELS = [];

function makeId() {
  return `ch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function loadChannels() {
  const file = getChannelsFile();
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(DEFAULT_CHANNELS, null, 2), "utf8");
    return DEFAULT_CHANNELS;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : DEFAULT_CHANNELS;
  } catch (e) {
    console.error("[channels-store] Failed to read channels.json, using defaults:", e.message);
    return DEFAULT_CHANNELS;
  }
}

export function saveChannels(channels) {
  if (!Array.isArray(channels)) {
    throw new Error("channels must be an array");
  }

  const cleaned = [];
  const seenChannelIds = new Set();

  for (const entry of channels) {
    const name = String(entry?.name ?? "").trim();
    const channelId = String(entry?.channelId ?? "").trim();

    if (!name) throw new Error(`Channel name is required (channelId: ${channelId || "?"})`);
    if (!CHANNEL_ID_PATTERN.test(channelId)) {
      throw new Error(`Invalid YouTube channel ID: "${channelId}" (expected format UCxxxxxxxxxxxxxxxxxxxxxx)`);
    }
    if (seenChannelIds.has(channelId)) continue; // dedupe, keep first
    seenChannelIds.add(channelId);

    cleaned.push({
      id: entry.id && typeof entry.id === "string" ? entry.id : makeId(),
      name,
      channelId,
    });
  }

  fs.writeFileSync(getChannelsFile(), JSON.stringify(cleaned, null, 2), "utf8");
  return cleaned;
}

export function getDefaultChannelId() {
  const channels = loadChannels();
  return channels[0]?.channelId || null;
}
