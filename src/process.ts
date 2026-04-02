import { execFile } from "node:child_process";
import { readdir, access } from "node:fs/promises";
import path from "node:path";
import { parseFilename } from "./parse-filename.js";

const INPUT_DIR = path.resolve("input");
const OUTPUT_DIR = path.resolve("output");
const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".avi", ".mov", ".ts"]);

async function fileExists(filepath: string): Promise<boolean> {
  try {
    await access(filepath);
    return true;
  } catch {
    return false;
  }
}

function runFfmpeg(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "-i", inputPath,
      "-vf", "crop=2560:1440:640:80",
      "-c:v", "libx264",
      "-preset", "slow",
      "-crf", "18",
      "-profile:v", "high",
      "-level", "4.2",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "192k",
      "-movflags", "+faststart",
      "-y",
      outputPath,
    ];

    console.log(`  ffmpeg encoding...`);
    const proc = execFile("ffmpeg", args, { maxBuffer: 10 * 1024 * 1024 });

    proc.stderr?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      // Show progress lines (frame= ...)
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

async function main() {
  const entries = await readdir(INPUT_DIR);
  const videoFiles = entries.filter((f) =>
    VIDEO_EXTENSIONS.has(path.extname(f).toLowerCase())
  );

  if (videoFiles.length === 0) {
    console.log("No video files found in input/");
    return;
  }

  console.log(`Found ${videoFiles.length} video file(s) in input/\n`);

  let processed = 0;
  let skipped = 0;

  for (const file of videoFiles) {
    const inputPath = path.join(INPUT_DIR, file);
    const outputName = path.basename(file, path.extname(file)) + ".mp4";
    const outputPath = path.join(OUTPUT_DIR, outputName);

    if (await fileExists(outputPath)) {
      console.log(`[skip] ${file} (already in output/)`);
      skipped++;
      continue;
    }

    const meta = parseFilename(file);
    if (meta) {
      console.log(
        `[process] ${meta.difficulty} ${meta.encounterName} (${meta.result})`
      );
    } else {
      console.log(`[process] ${file} (filename not recognized, processing anyway)`);
    }

    try {
      const start = Date.now();
      await runFfmpeg(inputPath, outputPath);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`  Done in ${elapsed}s → ${outputName}\n`);
      processed++;
    } catch (err) {
      console.error(`  Error processing ${file}:`, err);
    }
  }

  console.log(
    `\nFinished: ${processed} processed, ${skipped} skipped`
  );
}

main().catch(console.error);
