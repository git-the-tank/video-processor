import { readFile, writeFile, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { RaidConfig } from "./parse-filename.js";
import type { WclConfig } from "./wcl.js";

// --- Paths ---

export const INPUT_DIR = path.resolve("input");
export const OUTPUT_DIR = path.resolve("output");
export const CONFIG_PATH = path.resolve("config.json");
export const TOKEN_PATH = path.resolve("token.json");
export const UPLOADED_PATH = path.resolve("uploaded.json");
export const CHANNEL_PATH = path.resolve("channel.json");
export const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".avi", ".mov", ".ts"]);

// --- Types ---

export interface Config {
  guild: string;
  server: string;
  role: string;
  class: string;
  applyUrl: string;
  recruitMessage: string;
  playlistId: string;
  privacy: string;
  madeForKids: boolean;
  category: string;
  tags: string[];
  raids?: Record<string, RaidConfig>;
  wcl?: WclConfig;
}

export interface UploadRecord {
  [filename: string]: { videoId: string; uploadedAt: string };
}

// --- JSON helpers ---

export async function loadJson<T>(filepath: string): Promise<T> {
  return JSON.parse(await readFile(filepath, "utf-8"));
}

export async function saveJson(filepath: string, data: unknown): Promise<void> {
  await writeFile(filepath, JSON.stringify(data, null, 2));
}

// --- File helpers ---

export async function fileExists(filepath: string): Promise<boolean> {
  try {
    await access(filepath);
    return true;
  } catch {
    return false;
  }
}

export async function loadConfig(): Promise<Config> {
  if (!existsSync(CONFIG_PATH)) {
    console.error("config.json not found");
    process.exit(1);
  }
  return loadJson<Config>(CONFIG_PATH);
}

export async function loadUploaded(): Promise<UploadRecord> {
  if (!existsSync(UPLOADED_PATH)) return {};
  return loadJson<UploadRecord>(UPLOADED_PATH);
}

export async function saveUploaded(uploaded: UploadRecord): Promise<void> {
  await saveJson(UPLOADED_PATH, uploaded);
}
