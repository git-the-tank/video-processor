import { readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { parseFilename } from "./parse-filename.js";
import { runEncode } from "./ffmpeg.js";
import { INPUT_DIR, OUTPUT_DIR, VIDEO_EXTENSIONS, fileExists } from "./config.js";

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
      const tmpPath = outputPath + ".tmp.mp4";
      try {
        console.log(`  ffmpeg encoding...`);
        await runEncode(inputPath, tmpPath);
        await rename(tmpPath, outputPath);
      } catch (err) {
        await unlink(tmpPath).catch(() => {});
        throw err;
      }
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
