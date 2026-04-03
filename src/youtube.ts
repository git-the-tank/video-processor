import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import http from "node:http";
import { URL } from "node:url";
import readline from "node:readline/promises";
import { google } from "googleapis";
import {
  generateTitle,
  generateDescription,
  generateTags,
  type VideoMetadata,
} from "./parse-filename.js";
import { createProgressTracker } from "./upload-progress.js";
import { getChapters, formatChapters } from "./wcl.js";
import {
  type Config,
  type UploadRecord,
  TOKEN_PATH,
  CHANNEL_PATH,
  loadJson,
  saveJson,
  saveUploaded,
} from "./config.js";

export type YouTube = ReturnType<typeof google.youtube>;

// --- Auth ---

export async function authorize(): Promise<InstanceType<typeof google.auth.OAuth2>> {
  const client_id = process.env.GOOGLE_CLIENT_ID;
  const client_secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!client_id || !client_secret) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env");
  }

  const oauth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    "http://localhost:3000/callback"
  );

  if (existsSync(TOKEN_PATH)) {
    const token = await loadJson<object>(TOKEN_PATH);
    oauth2Client.setCredentials(token);
    return oauth2Client;
  }

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: [
      "https://www.googleapis.com/auth/youtube.upload",
      "https://www.googleapis.com/auth/youtube.readonly",
      "https://www.googleapis.com/auth/youtube.force-ssl",
    ],
  });

  console.log("Opening browser for authorization...");
  console.log(`If it doesn't open, visit: ${authUrl}\n`);

  const { exec } = await import("node:child_process");
  exec(`start "" "${authUrl}"`);

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost:3000`);
      const code = url.searchParams.get("code");
      if (code) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>Authorized! You can close this tab.</h1>");
        server.close();
        resolve(code);
      } else {
        res.writeHead(400);
        res.end("No code received");
        reject(new Error("No authorization code"));
      }
    });
    server.listen(3000);
  });

  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  await saveJson(TOKEN_PATH, tokens);
  console.log("Token saved.\n");
  return oauth2Client;
}

// --- Channel selection ---

export async function selectChannel(youtube: YouTube): Promise<string> {
  if (existsSync(CHANNEL_PATH)) {
    const saved = await loadJson<{ channelId: string; channelTitle: string }>(CHANNEL_PATH);
    console.log(`Using saved channel: ${saved.channelTitle}\n`);
    return saved.channelId;
  }

  const res = await youtube.channels.list({ part: ["snippet"], mine: true, maxResults: 50 });
  const channels = res.data.items ?? [];

  if (channels.length === 0) {
    console.error("No YouTube channels found for this account.");
    process.exit(1);
  }

  if (channels.length === 1) {
    const ch = channels[0];
    console.log(`Using channel: ${ch.snippet!.title}\n`);
    await saveJson(CHANNEL_PATH, { channelId: ch.id, channelTitle: ch.snippet!.title });
    return ch.id!;
  }

  console.log("Multiple YouTube channels found:\n");
  for (let i = 0; i < channels.length; i++) {
    console.log(`  ${i + 1}. ${channels[i].snippet!.title}`);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\nSelect channel (1-${channels.length}): `);
  rl.close();

  const idx = parseInt(answer, 10) - 1;
  if (idx < 0 || idx >= channels.length) {
    console.error("Invalid selection.");
    process.exit(1);
  }

  const selected = channels[idx];
  await saveJson(CHANNEL_PATH, { channelId: selected.id, channelTitle: selected.snippet!.title });
  console.log(`\nSaved channel: ${selected.snippet!.title}\n`);
  return selected.id!;
}

// --- Metadata helpers ---

export interface VideoUploadMeta {
  title: string;
  description: string;
  tags: string[];
  recordingDate?: Date;
}

export function buildMetadata(
  meta: VideoMetadata | null,
  config: Config,
  chaptersText?: string
): VideoUploadMeta {
  if (meta) {
    return {
      title: generateTitle(meta, config),
      description: generateDescription(meta, config, chaptersText),
      tags: generateTags(config.tags, meta, config.raids),
      recordingDate: meta.date,
    };
  }
  return {
    title: "",
    description: "",
    tags: config.tags,
  };
}

export async function fetchChapters(
  config: Config,
  meta: VideoMetadata
): Promise<string | undefined> {
  if (!config.wcl) return undefined;
  try {
    const markers = await getChapters(config.wcl, meta);
    if (markers) return formatChapters(markers);
  } catch (err) {
    console.warn(`WCL chapter lookup failed: ${err}`);
  }
  return undefined;
}

export function previewMetadata(upload: VideoUploadMeta, config: Config): void {
  console.log("--- YouTube Metadata Preview ---");
  console.log(`Title:       ${upload.title}`);
  console.log(`Description:\n${upload.description}`);
  console.log(`Tags:        ${upload.tags.join(", ")}`);
  console.log(`Privacy:     ${config.privacy}`);
  if (upload.recordingDate) {
    console.log(`Recorded:    ${upload.recordingDate.toISOString()}`);
  }
  console.log("--------------------------------");
}

export async function confirmPrompt(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(message);
  rl.close();
  return answer.toLowerCase() === "y";
}

// --- Upload ---

export interface UploadOptions {
  onProgress?: (pct: number, speed: string, eta: string) => void;
}

export async function uploadVideo(
  youtube: YouTube,
  filePath: string,
  upload: VideoUploadMeta,
  config: Config,
  options?: UploadOptions
): Promise<string> {
  const fileSize = (await stat(filePath)).size;
  const recordingDate = upload.recordingDate;

  const progressCallback = options?.onProgress ?? ((pct: number, speed: string, eta: string) => {
    process.stdout.write(`\r\x1b[K  upload ${pct.toFixed(1)}% ${speed} ETA ${eta}`);
  });

  const res = await youtube.videos.insert(
    {
      part: ["snippet", "status", ...(recordingDate ? ["recordingDetails"] : [])],
      requestBody: {
        snippet: {
          title: upload.title,
          description: upload.description,
          tags: upload.tags,
          categoryId: config.category,
        },
        status: {
          privacyStatus: config.privacy,
          selfDeclaredMadeForKids: config.madeForKids,
        },
        ...(recordingDate && {
          recordingDetails: { recordingDate: recordingDate.toISOString() },
        }),
      },
      media: {
        body: createReadStream(filePath),
      },
    },
    {
      onUploadProgress: createProgressTracker(fileSize, progressCallback),
    }
  );

  if (!options?.onProgress) process.stdout.write("\n");

  const videoId = res.data.id!;

  if (config.playlistId) {
    await youtube.playlistItems.insert({
      part: ["snippet"],
      requestBody: {
        snippet: {
          playlistId: config.playlistId,
          resourceId: { kind: "youtube#video", videoId },
        },
      },
    });
  }

  return videoId;
}

export async function uploadAndRecord(
  youtube: YouTube,
  filePath: string,
  filename: string,
  upload: VideoUploadMeta,
  config: Config,
  uploaded: UploadRecord,
  options?: UploadOptions
): Promise<string> {
  const videoId = await uploadVideo(youtube, filePath, upload, config, options);
  uploaded[filename] = { videoId, uploadedAt: new Date().toISOString() };
  await saveUploaded(uploaded);
  return videoId;
}

// --- Connect to YouTube ---

export async function connectYouTube(): Promise<YouTube> {
  const auth = await authorize();
  const youtube = google.youtube({ version: "v3", auth });
  await selectChannel(youtube);
  return youtube;
}

export function hasCredentials(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}
