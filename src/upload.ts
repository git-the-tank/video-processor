import { readdir } from "node:fs/promises";
import path from "node:path";
import { parseFilename } from "./parse-filename.js";
import {
  loadConfig,
  loadUploaded,
  OUTPUT_DIR,
} from "./config.js";
import {
  connectYouTube,
  hasCredentials,
  buildMetadata,
  fetchChapters,
  previewMetadata,
  confirmPrompt,
  uploadAndRecord,
} from "./youtube.js";

async function main() {
  const args = process.argv.slice(2);
  let specificFile: string | null = null;
  const fileIdx = args.indexOf("--file");
  if (fileIdx !== -1 && args[fileIdx + 1]) {
    specificFile = args[fileIdx + 1];
  }

  const config = await loadConfig();

  if (!hasCredentials()) {
    console.error(
      "Google credentials not found in .env.\n" +
        "Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to your .env file.\n" +
        "Get these from https://console.cloud.google.com/ (OAuth 2.0 Desktop app credentials)"
    );
    process.exit(1);
  }

  const youtube = await connectYouTube();
  const uploaded = await loadUploaded();

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
    const chaptersText = meta ? await fetchChapters(config, meta) : undefined;
    const upload = buildMetadata(meta, config, chaptersText);

    if (!meta) {
      upload.title = path.basename(file, ".mp4");
      console.log(`  Warning: Could not parse filename, using raw name as title`);
    }

    console.log(`\n--- [${uploadCount + skipCount + 1}/${videoFiles.length}] ---`);
    previewMetadata(upload, config);

    if (!await confirmPrompt("Upload? (y/N): ")) {
      console.log("  Skipped.\n");
      continue;
    }

    try {
      const filePath = path.join(OUTPUT_DIR, file);
      const videoId = await uploadAndRecord(
        youtube, filePath, file, upload, config, uploaded
      );
      console.log(`  Uploaded: https://youtu.be/${videoId}\n`);
      uploadCount++;
    } catch (err) {
      console.error(`  Error uploading ${file}:`, err);
    }
  }

  console.log(`\nFinished: ${uploadCount} uploaded, ${skipCount} skipped`);
}

main().catch(console.error);
