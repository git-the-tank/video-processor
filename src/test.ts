import { readdir, unlink, rename } from "node:fs/promises";
import path from "node:path";
import { parseFilename } from "./parse-filename.js";
import { runEncode, getDuration } from "./ffmpeg.js";
import { loadConfig, INPUT_DIR, OUTPUT_DIR, VIDEO_EXTENSIONS } from "./config.js";
import {
  connectYouTube,
  hasCredentials,
  buildMetadata,
  fetchChapters,
  previewMetadata,
  confirmPrompt,
  uploadVideo,
} from "./youtube.js";

const CLIP_DURATION = 15;

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
  console.log(`Source: ${sourceFile}\n`);

  // Step 2: Show metadata preview before encoding
  const meta = parseFilename(sourceFile);
  const config = await loadConfig();

  let chaptersText: string | undefined;
  if (meta && config.wcl) {
    console.log("Querying Warcraftlogs for chapters...");
    chaptersText = await fetchChapters(config, meta);
    if (chaptersText) {
      console.log(`Found chapters\n`);
    } else {
      console.log("No chapters found\n");
    }
  }

  const upload = buildMetadata(meta, config, chaptersText);
  if (meta) {
    upload.title = `[TEST] ${upload.title}`;
  } else {
    upload.title = `[TEST] ${path.basename(sourceFile, path.extname(sourceFile))}`;
    upload.description = "Test upload";
  }

  previewMetadata(upload, config);
  console.log("");

  if (!await confirmPrompt("Encode test clip and upload? (y/N): ")) {
    console.log("Aborted.");
    return;
  }

  // Step 3: Get duration, calculate midpoint
  const duration = await getDuration(inputPath);
  const midpoint = duration / 2;
  const startTime = Math.max(0, midpoint - CLIP_DURATION / 2);
  console.log(`\nDuration: ${duration.toFixed(1)}s, clipping ${startTime.toFixed(1)}s–${(startTime + CLIP_DURATION).toFixed(1)}s`);

  // Step 4: Crop the 15s clip
  const testOutputName = `TEST_${path.basename(sourceFile, path.extname(sourceFile))}.mp4`;
  const outputPath = path.join(OUTPUT_DIR, testOutputName);

  const encodeStart = Date.now();
  const tmpPath = outputPath + ".tmp.mp4";
  try {
    console.log(`  Encoding ${CLIP_DURATION}s clip starting at ${startTime.toFixed(1)}s...`);
    await runEncode(inputPath, tmpPath, { startTime, duration: CLIP_DURATION });
    await rename(tmpPath, outputPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
  const encodeElapsed = ((Date.now() - encodeStart) / 1000).toFixed(1);
  console.log(`  Encoded in ${encodeElapsed}s → ${testOutputName}\n`);

  // Step 5: Upload
  if (!hasCredentials()) {
    console.log("Skipping upload — Google credentials not in .env.");
    console.log(`Test clip saved to: ${outputPath}`);
    return;
  }

  console.log("Authenticating...");
  const youtube = await connectYouTube();

  console.log("Uploading...");
  const videoId = await uploadVideo(youtube, outputPath, upload, config);

  console.log(`\nUploaded: https://youtu.be/${videoId}`);
  console.log(`Test clip saved locally: ${outputPath}`);

  if (await confirmPrompt("\nDelete the test clip from output/? (y/N): ")) {
    await unlink(outputPath);
    console.log("Test clip deleted.");
  }
}

main().catch(console.error);
