import { execFile } from "node:child_process";
import { readFile, writeFile, readdir, access, stat, rename, unlink } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import http from "node:http";
import { URL } from "node:url";
import readline from "node:readline/promises";
import { google } from "googleapis";
import { videoEncodeArgs, videoLevel } from "./encoder.js";
import {
  parseFilename,
  generateTitle,
  generateDescription,
} from "./parse-filename.js";
import { createProgressTracker } from "./upload-progress.js";
import { setEncode, setUpload, startStatus, clearStatus, log } from "./status-line.js";

const INPUT_DIR = path.resolve("input");
const OUTPUT_DIR = path.resolve("output");
const CONFIG_PATH = path.resolve("config.json");
const CLIENT_SECRET_PATH = path.resolve("client_secret.json");
const TOKEN_PATH = path.resolve("token.json");
const UPLOADED_PATH = path.resolve("uploaded.json");
const CHANNEL_PATH = path.resolve("channel.json");
const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".avi", ".mov", ".ts"]);

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

async function fileExists(filepath: string): Promise<boolean> {
  try {
    await access(filepath);
    return true;
  } catch {
    return false;
  }
}

async function loadUploaded(): Promise<UploadRecord> {
  if (!existsSync(UPLOADED_PATH)) return {};
  return loadJson<UploadRecord>(UPLOADED_PATH);
}

// --- ffmpeg ---

function runFfmpeg(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "-i", inputPath,
      "-vf", "crop=2560:1440:640:80",
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

    const proc = execFile("ffmpeg", args, { maxBuffer: 10 * 1024 * 1024 });

    proc.stderr?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line.startsWith("frame=")) {
        const timeMatch = line.match(/time=(\S+)/);
        const speedMatch = line.match(/speed=(\S+)/);
        const time = timeMatch?.[1] ?? "?";
        const speed = speedMatch?.[1] ?? "?";
        setEncode(`encode ${time} @ ${speed}`);
      }
    });

    proc.on("close", (code) => {
      setEncode("");
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });

    proc.on("error", reject);
  });
}

// --- YouTube auth ---

async function authorize(): Promise<InstanceType<typeof google.auth.OAuth2>> {
  const credentials = await loadJson<{
    installed: { client_id: string; client_secret: string };
  }>(CLIENT_SECRET_PATH);

  const { client_id, client_secret } = credentials.installed;
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

// --- Upload ---

async function uploadFile(
  youtube: ReturnType<typeof google.youtube>,
  filePath: string,
  outputName: string,
  config: Config,
  uploaded: UploadRecord
): Promise<void> {
  const meta = parseFilename(outputName);
  let title: string;
  let description: string;

  if (meta) {
    title = generateTitle(meta, config);
    description = generateDescription(meta, config);
  } else {
    title = path.basename(outputName, ".mp4");
    description = "";
  }

  log(`  [upload] ${title}`);
  setUpload("upload starting...");

  const fileSize = (await stat(filePath)).size;
  const res = await youtube.videos.insert(
    {
      part: ["snippet", "status"],
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
      },
      media: {
        body: createReadStream(filePath),
      },
    },
    {
      onUploadProgress: createProgressTracker(fileSize),
    }
  );
  setUpload("");
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

  uploaded[outputName] = { videoId, uploadedAt: new Date().toISOString() };
  await saveJson(UPLOADED_PATH, uploaded);
  log(`  Uploaded: https://youtu.be/${videoId}`);
}

// --- Main pipeline ---

async function main() {
  const config = await loadJson<Config>(CONFIG_PATH);

  // Auth upfront so we don't hit a prompt mid-pipeline
  let youtube: ReturnType<typeof google.youtube> | null = null;
  if (existsSync(CLIENT_SECRET_PATH)) {
    const auth = await authorize();
    youtube = google.youtube({ version: "v3", auth });
    await selectChannel(youtube);
  } else {
    console.log("No client_secret.json — will process only, no uploads.\n");
  }

  const uploaded = await loadUploaded();

  // Find input files that need work
  const entries = await readdir(INPUT_DIR);
  const inputFiles = entries.filter((f) =>
    VIDEO_EXTENSIONS.has(path.extname(f).toLowerCase())
  );

  if (inputFiles.length === 0) {
    console.log("No video files found in input/");
    return;
  }

  // Build work list: what needs encoding, what needs uploading
  interface WorkItem {
    inputFile: string;
    outputName: string;
    inputPath: string;
    outputPath: string;
    needsEncode: boolean;
    needsUpload: boolean;
  }

  const work: WorkItem[] = [];
  for (const file of inputFiles) {
    const outputName = path.basename(file, path.extname(file)) + ".mp4";
    const outputPath = path.join(OUTPUT_DIR, outputName);
    const needsEncode = !(await fileExists(outputPath));
    const needsUpload = !uploaded[outputName];
    if (needsEncode || needsUpload) {
      work.push({
        inputFile: file,
        outputName,
        inputPath: path.join(INPUT_DIR, file),
        outputPath,
        needsEncode,
        needsUpload,
      });
    }
  }

  if (work.length === 0) {
    console.log("Everything is processed and uploaded. Nothing to do.");
    return;
  }

  const encodeCount = work.filter((w) => w.needsEncode).length;
  const uploadCount = work.filter((w) => w.needsUpload).length;
  console.log(`Pipeline: ${work.length} file(s) — ${encodeCount} to encode, ${uploadCount} to upload\n`);

  startStatus();
  let pendingUpload: Promise<void> | null = null;
  let processedCount = 0;

  for (const item of work) {
    processedCount++;
    const label = `[${processedCount}/${work.length}]`;
    const meta = parseFilename(item.inputFile);
    const displayName = meta
      ? `${meta.difficulty} ${meta.encounterName} (${meta.result})`
      : item.inputFile;

    log(`${label} ${displayName}`);

    // Encode if needed
    if (item.needsEncode) {
      const start = Date.now();
      const tmpPath = item.outputPath + ".tmp.mp4";
      try {
        await runFfmpeg(item.inputPath, tmpPath);
        await rename(tmpPath, item.outputPath);
      } catch (err) {
        await unlink(tmpPath).catch(() => {});
        throw err;
      }
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      log(`  Encoded in ${elapsed}s`);
    } else {
      log(`  Already encoded`);
    }

    // Wait for any previous upload to finish before starting the next one
    if (pendingUpload) {
      await pendingUpload;
      pendingUpload = null;
    }

    // Start upload in background (runs while next encode happens)
    if (item.needsUpload && youtube) {
      pendingUpload = uploadFile(youtube, item.outputPath, item.outputName, config, uploaded)
        .catch((err) => log(`  Upload error: ${err.message}`));
    } else if (!item.needsUpload) {
      log(`  Already uploaded`);
    }

    log("");
  }

  // Wait for final upload
  if (pendingUpload) {
    await pendingUpload;
  }

  clearStatus();
  console.log("\nAll done!");
}

main().catch(console.error);
