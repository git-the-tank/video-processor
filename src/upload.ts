import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import http from "node:http";
import { URL } from "node:url";
import readline from "node:readline/promises";
import { google } from "googleapis";
import {
  parseFilename,
  generateTitle,
  generateDescription,
} from "./parse-filename.js";
import { createProgressTracker } from "./upload-progress.js";
import { getChapters, formatChapters, type WclConfig } from "./wcl.js";

const OUTPUT_DIR = path.resolve("output");
const CONFIG_PATH = path.resolve("config.json");
const TOKEN_PATH = path.resolve("token.json");
const UPLOADED_PATH = path.resolve("uploaded.json");
const CHANNEL_PATH = path.resolve("channel.json");

interface Config {
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
  wcl?: WclConfig;
}

interface UploadRecord {
  [filename: string]: { videoId: string; uploadedAt: string };
}

async function loadJson<T>(filepath: string): Promise<T> {
  return JSON.parse(await readFile(filepath, "utf-8"));
}

async function saveJson(filepath: string, data: unknown): Promise<void> {
  await writeFile(filepath, JSON.stringify(data, null, 2));
}

async function loadUploaded(): Promise<UploadRecord> {
  if (!existsSync(UPLOADED_PATH)) return {};
  return loadJson<UploadRecord>(UPLOADED_PATH);
}

// OAuth2 flow: opens browser, listens on localhost for callback
async function authorize(): Promise<InstanceType<typeof google.auth.OAuth2>> {
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

  // Try loading existing token
  if (existsSync(TOKEN_PATH)) {
    const token = await loadJson<object>(TOKEN_PATH);
    oauth2Client.setCredentials(token);
    return oauth2Client;
  }

  // No token — need to authorize
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

  // Open browser
  const { exec } = await import("node:child_process");
  exec(`start "" "${authUrl}"`);

  // Listen for callback
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

async function selectChannel(
  youtube: ReturnType<typeof google.youtube>
): Promise<string> {
  // Check if we already saved a channel choice
  if (existsSync(CHANNEL_PATH)) {
    const saved = await loadJson<{ channelId: string; channelTitle: string }>(CHANNEL_PATH);
    console.log(`Using saved channel: ${saved.channelTitle}\n`);
    return saved.channelId;
  }

  // List all channels the authenticated user has access to
  const res = await youtube.channels.list({
    part: ["snippet"],
    mine: true,
    maxResults: 50,
  });

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

  // Multiple channels — let user pick
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

async function uploadVideo(
  youtube: ReturnType<typeof google.youtube>,
  filePath: string,
  title: string,
  description: string,
  config: Config,
  playlistId: string,
  recordingDate?: Date
): Promise<string> {
  const fileSize = (await stat(filePath)).size;
  const res = await youtube.videos.insert(
    {
      part: ["snippet", "status", ...(recordingDate ? ["recordingDetails"] : [])],
      requestBody: {
        snippet: {
          title,
          description,
          tags: config.tags,
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
      onUploadProgress: createProgressTracker(fileSize, (pct, speed, eta) => {
        process.stdout.write(`\r\x1b[K  upload ${pct.toFixed(1)}% ${speed} ETA ${eta}`);
      }),
    }
  );
  process.stdout.write("\n");

  const videoId = res.data.id!;

  // Add to playlist if configured
  if (playlistId) {
    await youtube.playlistItems.insert({
      part: ["snippet"],
      requestBody: {
        snippet: {
          playlistId,
          resourceId: {
            kind: "youtube#video",
            videoId,
          },
        },
      },
    });
  }

  return videoId;
}

async function main() {
  // Parse CLI args
  const args = process.argv.slice(2);
  let specificFile: string | null = null;
  const fileIdx = args.indexOf("--file");
  if (fileIdx !== -1 && args[fileIdx + 1]) {
    specificFile = args[fileIdx + 1];
  }

  // Load config
  if (!existsSync(CONFIG_PATH)) {
    console.error("config.json not found");
    process.exit(1);
  }
  const config = await loadJson<Config>(CONFIG_PATH);

  // Check for credentials
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    console.error(
      "Google credentials not found in .env.\n" +
        "Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to your .env file.\n" +
        "Get these from https://console.cloud.google.com/ (OAuth 2.0 Desktop app credentials)"
    );
    process.exit(1);
  }

  const auth = await authorize();
  const youtube = google.youtube({ version: "v3", auth });

  const channelId = await selectChannel(youtube);
  const uploaded = await loadUploaded();

  // Get files to upload
  const entries = await readdir(OUTPUT_DIR);
  let videoFiles = entries.filter((f) => f.endsWith(".mp4"));

  if (specificFile) {
    videoFiles = videoFiles.filter((f) => f === specificFile);
    if (videoFiles.length === 0) {
      console.error(`File not found in output/: ${specificFile}`);
      process.exit(1);
    }
  }

  if (videoFiles.length === 0) {
    console.log("No video files to upload in output/");
    return;
  }

  console.log(`Found ${videoFiles.length} video(s) to check\n`);

  let uploadCount = 0;
  let skipCount = 0;

  for (const file of videoFiles) {
    if (uploaded[file]) {
      console.log(`[skip] ${file} (already uploaded: ${uploaded[file].videoId})`);
      skipCount++;
      continue;
    }

    const meta = parseFilename(file);
    let title: string;
    let description: string;

    if (meta) {
      title = generateTitle(meta, config);
      let chaptersText: string | undefined;
      if (config.wcl) {
        try {
          const markers = await getChapters(config.wcl, meta);
          if (markers) chaptersText = formatChapters(markers);
        } catch (err) {
          console.warn(`WCL chapter lookup failed: ${err}`);
        }
      }
      description = generateDescription(meta, config, chaptersText);
    } else {
      title = path.basename(file, ".mp4");
      description = "";
      console.log(`  Warning: Could not parse filename, using raw name as title`);
    }

    console.log(`[upload] ${title}`);

    try {
      const filePath = path.join(OUTPUT_DIR, file);
      const videoId = await uploadVideo(
        youtube,
        filePath,
        title,
        description,
        config,
        config.playlistId,
        meta?.date
      );

      uploaded[file] = { videoId, uploadedAt: new Date().toISOString() };
      await saveJson(UPLOADED_PATH, uploaded);

      console.log(`  Uploaded: https://youtu.be/${videoId}\n`);
      uploadCount++;
    } catch (err) {
      console.error(`  Error uploading ${file}:`, err);
    }
  }

  console.log(`\nFinished: ${uploadCount} uploaded, ${skipCount} skipped`);
}

main().catch(console.error);
