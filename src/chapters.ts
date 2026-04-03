import {
  parseFilename,
  generateTitle,
  generateDescription,
  generateTags,
} from "./parse-filename.js";
import { getChapters, formatChapters } from "./wcl.js";
import {
  loadConfig,
  loadUploaded,
  type UploadRecord,
} from "./config.js";
import {
  connectYouTube,
  hasCredentials,
  confirmPrompt,
} from "./youtube.js";

async function main() {
  console.log("=== RETROACTIVE CHAPTER UPDATE ===\n");

  const config = await loadConfig();

  if (!config.wcl) {
    console.error("No 'wcl' section in config.json. Add your WCL API credentials first.");
    process.exit(1);
  }

  if (!hasCredentials()) {
    console.error("Google credentials not found in .env — needed for YouTube API updates.");
    process.exit(1);
  }

  const uploaded = await loadUploaded();
  const entries = Object.entries(uploaded);

  if (entries.length === 0) {
    console.log("No uploaded videos found.");
    return;
  }

  // Parse --file flag for targeting a specific video
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf("--file");
  const specificFile = fileIdx !== -1 ? args[fileIdx + 1] : null;

  console.log("Authenticating with YouTube...");
  const youtube = await connectYouTube();

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

    console.log("\n  New description:");
    console.log(`    ${newDescription.replace(/\n/g, "\n    ")}`);

    if (!await confirmPrompt("\n  Update this video's description? (y/N): ")) {
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
            tags: generateTags(config.tags, meta, config.raids),
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

  console.log(`\nDone: ${updated} updated, ${skipped} skipped`);
}

main().catch(console.error);
