import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { URL } from "node:url";
import { google } from "googleapis";

const TOKEN_PATH = "token.json";

async function loadJson<T>(filepath: string): Promise<T> {
  return JSON.parse(await readFile(filepath, "utf-8"));
}

async function saveJson(filepath: string, data: unknown): Promise<void> {
  await writeFile(filepath, JSON.stringify(data, null, 2));
}

async function main() {
  console.log("=== GOOGLE AUTH TEST ===\n");

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env");
    process.exit(1);
  }

  console.log(`Client ID: ${clientId.slice(0, 12)}...`);
  console.log(`Client Secret: ${clientSecret.slice(0, 4)}...`);

  const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    "http://localhost:3000/callback"
  );

  // Check existing token
  if (existsSync(TOKEN_PATH)) {
    console.log("\nFound existing token.json, testing it...");
    const token = await loadJson<object>(TOKEN_PATH);
    oauth2Client.setCredentials(token);
  } else {
    console.log("\nNo token.json — starting OAuth flow...");

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: [
        "https://www.googleapis.com/auth/youtube.upload",
        "https://www.googleapis.com/auth/youtube.readonly",
        "https://www.googleapis.com/auth/youtube.force-ssl",
      ],
    });

    console.log(`\nIf browser doesn't open, visit:\n${authUrl}\n`);

    const { exec } = await import("node:child_process");
    exec(`start "" "${authUrl}"`);

    const code = await new Promise<string>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url!, "http://localhost:3000");
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
    console.log("Token saved.");
  }

  // Test: list channels
  console.log("\nTesting youtube.channels.list (readonly)...");
  const youtube = google.youtube({ version: "v3", auth: oauth2Client });

  try {
    const res = await youtube.channels.list({ part: ["snippet"], mine: true, maxResults: 5 });
    const channels = res.data.items ?? [];
    if (channels.length === 0) {
      console.log("  No channels found (auth works but no channels on account)");
    } else {
      for (const ch of channels) {
        console.log(`  Channel: ${ch.snippet!.title} (${ch.id})`);
      }
    }
    console.log("  PASS: readonly scope works");
  } catch (err) {
    console.error(`  FAIL: ${err}`);
  }

  // Test: videos.list (force-ssl) — just list our own videos
  console.log("\nTesting youtube.videos.list (force-ssl)...");
  try {
    const res = await youtube.search.list({
      part: ["snippet"],
      forMine: true,
      type: ["video"],
      maxResults: 1,
    });
    const videos = res.data.items ?? [];
    if (videos.length > 0) {
      const v = videos[0];
      console.log(`  Found video: ${v.snippet!.title} (${v.id!.videoId})`);

      // Test: videos.update — try a no-op update on this video
      console.log("\nTesting youtube.videos.update (force-ssl)...");
      const detail = await youtube.videos.list({
        part: ["snippet"],
        id: [v.id!.videoId!],
      });
      const video = detail.data.items![0];
      await youtube.videos.update({
        part: ["snippet"],
        requestBody: {
          id: v.id!.videoId!,
          snippet: {
            title: video.snippet!.title!,
            description: video.snippet!.description!,
            tags: video.snippet!.tags ?? [],
            categoryId: video.snippet!.categoryId!,
          },
        },
      });
      console.log("  PASS: videos.update works");
    } else {
      console.log("  No videos found — can't test update");
    }
  } catch (err) {
    console.error(`  FAIL: ${err}`);
  }

  console.log("\nDone.");
}

main().catch(console.error);
