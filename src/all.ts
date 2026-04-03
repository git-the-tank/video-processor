import { readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { parseFilename } from "./parse-filename.js";
import { runEncode } from "./ffmpeg.js";
import {
  loadConfig,
  loadUploaded,
  fileExists,
  INPUT_DIR,
  OUTPUT_DIR,
  VIDEO_EXTENSIONS,
} from "./config.js";
import {
  connectYouTube,
  hasCredentials,
  buildMetadata,
  fetchChapters,
  previewMetadata,
  confirmPrompt,
  uploadAndRecord,
  type YouTube,
} from "./youtube.js";
import {
  initDashboard,
  updateEncode,
  updateUpload,
  stopDashboard,
  type FileEntry,
} from "./dashboard.js";

// --- Main pipeline ---

async function main() {
  const config = await loadConfig();

  // Auth upfront so we don't hit a prompt mid-pipeline
  let youtube: YouTube | null = null;
  if (hasCredentials()) {
    youtube = await connectYouTube();
  } else {
    console.log("No Google credentials in .env — will process only, no uploads.\n");
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

  // Build work list
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

  // Per-video metadata preview + approval before any encoding starts
  const approved: typeof work = [];
  for (let i = 0; i < approved.length; i++) {
    const item = approved[i];
    const meta = parseFilename(item.inputFile);
    const chaptersText = meta ? await fetchChapters(config, meta) : undefined;
    const upload = buildMetadata(meta, config, chaptersText);
    if (!meta) upload.title = path.basename(item.outputName, ".mp4");

    console.log(`\n--- [${i + 1}/${work.length}] ---`);
    previewMetadata(upload, config);

    if (await confirmPrompt("Process this video? (y/N): ")) {
      approved.push(item);
    } else {
      console.log("  Skipped.");
    }
  }

  if (approved.length === 0) {
    console.log("\nNothing to process.");
    return;
  }

  console.log(`\n  Source:  3840x1600 @ 60fps`);
  console.log(`  Crop:    2844x1600 (offset 498:0)`);
  console.log(`  Scale:   2560x1440 (1440p)`);
  console.log("");

  const encodeCount = approved.filter((w) => w.needsEncode).length;
  const uploadCount = approved.filter((w) => w.needsUpload).length;
  const header = `Pipeline: ${approved.length} file(s) — ${encodeCount} to encode, ${uploadCount} to upload`;

  const fileEntries: FileEntry[] = approved.map((item) => {
    const meta = parseFilename(item.inputFile);
    const displayName = meta
      ? `${meta.difficulty} ${meta.encounterName} (${meta.result})`
      : item.inputFile;
    return {
      displayName,
      encode: item.needsEncode ? { status: "pending" } : { status: "skipped" },
      upload: !item.needsUpload
        ? { status: "skipped" }
        : youtube
          ? { status: "pending" }
          : { status: "not-applicable" },
    };
  });

  initDashboard(fileEntries, header);

  let pendingUpload: Promise<void> | null = null;

  for (let i = 0; i < approved.length; i++) {
    const item = approved[i];

    // Encode if needed
    if (item.needsEncode) {
      updateEncode(i, { status: "active", progress: "starting..." });
      const start = Date.now();
      const tmpPath = item.outputPath + ".tmp.mp4";
      try {
        await runEncode(item.inputPath, tmpPath, {
          onProgress: (progress) => {
            updateEncode(i, { status: "active", progress });
          },
        });
        await rename(tmpPath, item.outputPath);
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        updateEncode(i, { status: "done", elapsed: `${elapsed}s` });
      } catch (err: any) {
        await unlink(tmpPath).catch(() => {});
        updateEncode(i, { status: "error", message: err.message });
        continue;
      }
    }

    // Mark upload as queued if applicable
    if (item.needsUpload && youtube) {
      updateUpload(i, { status: "queued" });
    }

    // Wait for any previous upload to finish before starting the next one
    if (pendingUpload) {
      await pendingUpload;
      pendingUpload = null;
    }

    // Start upload in background (runs while next encode happens)
    if (item.needsUpload && youtube) {
      const idx = i;
      const uploadStart = Date.now();
      updateUpload(idx, { status: "active", pct: 0, speed: "---", eta: "---" });

      const meta = parseFilename(item.outputName);
      const chaptersText = meta ? await fetchChapters(config, meta) : undefined;
      const upload = buildMetadata(meta, config, chaptersText);
      if (!meta) upload.title = path.basename(item.outputName, ".mp4");

      pendingUpload = uploadAndRecord(
        youtube, item.outputPath, item.outputName, upload, config, uploaded,
        {
          onProgress: (pct, speed, eta) =>
            updateUpload(idx, { status: "active", pct, speed, eta }),
        }
      )
        .then((videoId) => {
          const elapsed = ((Date.now() - uploadStart) / 1000).toFixed(1);
          updateUpload(idx, { status: "done", url: `https://youtu.be/${videoId}`, elapsed: `${elapsed}s` });
        })
        .catch((err) => {
          updateUpload(idx, { status: "error", message: err.message });
        });
    }
  }

  // Wait for final upload
  if (pendingUpload) {
    await pendingUpload;
  }

  stopDashboard();
  console.log("\nAll done!");
}

main().catch(console.error);
