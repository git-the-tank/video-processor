import { videoEncodeArgs, videoLevel } from "./encoder.js";
import { execFile } from "node:child_process";
import { readdir, unlink, stat, rename } from "node:fs/promises";
import path from "node:path";
import { createReadStream, existsSync } from "node:fs";
import http from "node:http";
import { URL } from "node:url";
import readline from "node:readline/promises";
import { readFile, writeFile } from "node:fs/promises";
import { google } from "googleapis";
import {
  parseFilename,
  generateTitle,
  generateDescription,
} from "./parse-filename.js";
import { createProgressTracker } from "./upload-progress.js";
import { getChapters, formatChapters, type WclConfig } from "./wcl.js";

const INPUT_DIR = path.resolve("input");
const OUTPUT_DIR = path.resolve("output");
const CONFIG_PATH = path.resolve("config.json");
const TOKEN_PATH = path.resolve("token.json");
const CHANNEL_PATH = path.resolve("channel.json");
const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".avi", ".mov", ".ts"]);
const CLIP_DURATION = 15;

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

async function loadJson<T>(filepath: string): Promise<T> {
  return JSON.parse(await readFile(filepath, "utf-8"));
}

async function saveJson(filepath: string, data: unknown): Promise<void> {
  await writeFile(filepath, JSON.stringify(data, null, 2));
}

function getDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filePath],
      (err, stdout) => {
        if (err) return reject(err);
        resolve(parseFloat(stdout.trim()));
      }
    );
  });
}

function runFfmpeg(inputPath: string, outputPath: string, startTime: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "-ss", startTime.toString(),
      "-i", inputPath,
      "-t", CLIP_DURATION.toString(),
      "-vf", "crop=2844:1600:498:0,scale=2560:1440",
      ...videoEncodeArgs,
      "-profile:v", "high",
      "-level", videoLevel,
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "192k",
      "-movflags", "+faststart",
      "-y",
      outputPath,
    ];

    console.log(`  Encoding ${CLIP_DURATION}s clip starting at ${startTime.toFixed(1)}s...`);
    const proc = execFile("ffmpeg", args, { maxBuffer: 10 * 1024 * 1024 });

    proc.stderr?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line.startsWith("frame=")) {
        process.stdout.write(`\r  ${line.slice(0, 80)}`);
      }
    });

    proc.on("close", (code) => {
      process.stdout.write("\n");
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });

    proc.on("error", reject);
  });
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

async function selectChannel(
  youtube: ReturnType<typeof google.youtube>
): Promise<string> {
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

async function main() {
  console.log("=== TEST MODE ===");
  console.log(`Will take a ${CLIP_DURATION}s clip from the middle of a video, crop it, and upload.\n`);

  // Step 1: Find a video in input/
  const entries = await readdir(INPUT_DIR);
  const videoFiles = entries.filter((f) =>
    VIDEO_EXTENSIONS.has(path.extname(f).toLowerCase())
  );

  if (videoFiles.length === 0) {
    console.error("No video files found in input/. Drop a video there first.");
    process.exit(1);
  }

  const sourceFile = videoFiles[0];
  const inputPath = path.join(INPUT_DIR, sourceFile);
  console.log(`Source: ${sourceFile}`);

  // Step 2: Get duration, calculate midpoint
  const duration = await getDuration(inputPath);
  const midpoint = duration / 2;
  const startTime = Math.max(0, midpoint - CLIP_DURATION / 2);
  console.log(`Duration: ${duration.toFixed(1)}s, clipping ${startTime.toFixed(1)}s–${(startTime + CLIP_DURATION).toFixed(1)}s`);

  // Step 3: Crop the 15s clip
  const testOutputName = `TEST_${path.basename(sourceFile, path.extname(sourceFile))}.mp4`;
  const outputPath = path.join(OUTPUT_DIR, testOutputName);

  const encodeStart = Date.now();
  const tmpPath = outputPath + ".tmp.mp4";
  try {
    await runFfmpeg(inputPath, tmpPath, startTime);
    await rename(tmpPath, outputPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
  const encodeElapsed = ((Date.now() - encodeStart) / 1000).toFixed(1);
  console.log(`  Encoded in ${encodeElapsed}s → ${testOutputName}\n`);

  // Step 4: Show metadata preview
  const meta = parseFilename(sourceFile);
  const config = await loadJson<Config>(CONFIG_PATH);
  let title: string;
  let description: string;

  if (meta) {
    title = `[TEST] ${generateTitle(meta, config)}`;
    let chaptersText: string | undefined;
    if (config.wcl) {
      try {
        console.log("Querying Warcraftlogs for chapters...");
        const markers = await getChapters(config.wcl, meta);
        if (markers) {
          chaptersText = formatChapters(markers);
          console.log(`Found ${markers.length} chapters\n`);
        } else {
          console.log("No chapters found\n");
        }
      } catch (err) {
        console.warn(`WCL chapter lookup failed: ${err}\n`);
      }
    }
    description = generateDescription(meta, config, chaptersText);
  } else {
    title = `[TEST] ${path.basename(sourceFile, path.extname(sourceFile))}`;
    description = "Test upload";
  }

  console.log("--- YouTube Metadata Preview ---");
  console.log(`Title: ${title}`);
  console.log(`Description:\n${description}`);
  console.log(`Privacy: ${config.privacy}`);
  console.log(`Tags: ${config.tags.join(", ")}`);
  console.log("--------------------------------\n");

  // Step 5: Ask to proceed with upload
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    console.log("Skipping upload — Google credentials not in .env.");
    console.log(`Test clip saved to: ${outputPath}`);
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("Upload this test clip to YouTube? (y/N): ");
  rl.close();

  if (answer.toLowerCase() !== "y") {
    console.log(`\nTest clip saved to: ${outputPath}`);
    return;
  }

  // Step 6: Upload
  console.log("\nAuthenticating...");
  const auth = await authorize();
  const youtube = google.youtube({ version: "v3", auth });

  await selectChannel(youtube);

  console.log("Uploading...");
  const fileSize = (await stat(outputPath)).size;
  const recordingDate = meta?.date;
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
        body: createReadStream(outputPath),
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

  console.log(`\nUploaded: https://youtu.be/${videoId}`);
  console.log(`Test clip saved locally: ${outputPath}`);

  // Ask if they want to clean up
  const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
  const cleanup = await rl2.question("\nDelete the test clip from output/? (y/N): ");
  rl2.close();

  if (cleanup.toLowerCase() === "y") {
    await unlink(outputPath);
    console.log("Test clip deleted.");
  }
}

main().catch(console.error);
