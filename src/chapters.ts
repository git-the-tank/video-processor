import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import http from "node:http";
import { URL } from "node:url";
import readline from "node:readline/promises";
import { google } from "googleapis";
import {
  parseFilename,
  generateTitle,
  generateDescription,
} from "./parse-filename.js";
import { getChapters, formatChapters, type WclConfig } from "./wcl.js";

const CONFIG_PATH = "config.json";
const TOKEN_PATH = "token.json";
const CHANNEL_PATH = "channel.json";
const UPLOADED_PATH = "uploaded.json";

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

async function main() {
  console.log("=== RETROACTIVE CHAPTER UPDATE ===\n");

  const config = await loadJson<Config>(CONFIG_PATH);

  if (!config.wcl) {
    console.error("No 'wcl' section in config.json. Add your WCL API credentials first.");
    process.exit(1);
  }

  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    console.error("Google credentials not found in .env — needed for YouTube API updates.");
    process.exit(1);
  }

  if (!existsSync(UPLOADED_PATH)) {
    console.error("uploaded.json not found — no videos to update.");
    process.exit(1);
  }

  const uploaded = await loadJson<UploadRecord>(UPLOADED_PATH);
  const entries = Object.entries(uploaded);

  if (entries.length === 0) {
    console.log("No uploaded videos found.");
    return;
  }

  // Parse --file flag for targeting a specific video
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf("--file");
  const specificFile = fileIdx !== -1 ? args[fileIdx + 1] : null;

  // Auth with YouTube
  console.log("Authenticating with YouTube...");
  const auth = await authorize();
  const youtube = google.youtube({ version: "v3", auth });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  let updated = 0;
  let skipped = 0;

  for (const [filename, record] of entries) {
    if (specificFile && filename !== specificFile) continue;

    const meta = parseFilename(filename);
    if (!meta) {
      console.log(`[skip] ${filename} — could not parse filename`);
      skipped++;
      continue;
    }

    console.log(`\n--- ${meta.difficulty} ${meta.encounterName} (${record.videoId}) ---`);

    // Query WCL for chapters
    let chaptersText: string | undefined;
    try {
      console.log("  Querying Warcraftlogs...");
      const markers = await getChapters(config.wcl, meta);
      if (markers) {
        chaptersText = formatChapters(markers);
        console.log(`  Found ${markers.length} chapters:`);
        console.log(`    ${chaptersText.replace(/\n/g, "\n    ")}`);
      } else {
        console.log("  No chapters found (no phases or fewer than 3 chapters)");
        skipped++;
        continue;
      }
    } catch (err) {
      console.warn(`  WCL lookup failed: ${err}`);
      skipped++;
      continue;
    }

    // Build new description
    const newDescription = generateDescription(meta, config, chaptersText);
    const oldDescription = generateDescription(meta, config);

    console.log("\n  New description:");
    console.log(`    ${newDescription.replace(/\n/g, "\n    ")}`);

    const answer = await rl.question("\n  Update this video's description? (y/N): ");
    if (answer.toLowerCase() !== "y") {
      console.log("  Skipped.");
      skipped++;
      continue;
    }

    // Update the video via YouTube API
    try {
      await youtube.videos.update({
        part: ["snippet"],
        requestBody: {
          id: record.videoId,
          snippet: {
            title: generateTitle(meta, config),
            description: newDescription,
            tags: config.tags,
            categoryId: config.category,
          },
        },
      });
      console.log(`  Updated: https://youtu.be/${record.videoId}`);
      updated++;
    } catch (err) {
      console.error(`  Failed to update: ${err}`);
    }
  }

  rl.close();
  console.log(`\nDone: ${updated} updated, ${skipped} skipped`);
}

main().catch(console.error);
