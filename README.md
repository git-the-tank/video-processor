# WoW Video Processor

Automated pipeline for cropping ultrawide World of Warcraft recordings to 16:9 and uploading to YouTube with auto-generated metadata.

**Source:** 3840x1600 @ 60fps ultrawide recordings
**Output:** 2560x1440 (1440p) center-cropped, H.264 High profile, optimized for YouTube

## Prerequisites

- [Node.js 24+](https://nodejs.org/)
- [pnpm](https://pnpm.io/)
- [ffmpeg](https://ffmpeg.org/) (must be in PATH)

## Install

```bash
pnpm install
```

## Quick Start

1. Drop video files into `input/`
2. `pnpm run all` to encode and upload everything

## Commands

| Command | Description |
|---------|-------------|
| `pnpm run all` | **Pipelined encode + upload.** Encodes and uploads with overlap for throughput. |
| `pnpm run process` | Encode only — crop all videos in `input/` to `output/` |
| `pnpm run upload` | Upload only — upload all videos in `output/` to YouTube |
| `pnpm run upload -- --file "name.mp4"` | Upload a specific file |
| `pnpm run test` | Test mode — 15s clip from middle, crop, preview metadata, optionally upload |

## Pipeline (`pnpm run all`)

The `all` command is the main way to use this project. It pipelines encoding and uploading for maximum throughput:

```
V1: [===encode===]
V1:              [========upload========]
V2:              [===encode===]
V2:                           (wait...)[========upload========]
V3:                           [===encode===]
V3:                                                           [===upload===]
```

- Encodes are serial (CPU-bound), uploads are serial (network-bound), but they overlap
- Skips files already encoded (exist in `output/`) or already uploaded (in `uploaded.json`)
- If an upload fails, re-running picks it up — files in `output/` without an `uploaded.json` entry upload without re-encoding
- Works without YouTube credentials (encode-only if no `client_secret.json`)

## Test Mode

Best way to verify everything works end-to-end:

```bash
pnpm run test
```

1. Picks the first video in `input/`
2. Extracts a 15-second clip from the middle
3. Crops it to 2560x1440
4. Shows a preview of the YouTube title and description
5. Asks if you want to upload it (title prefixed with `[TEST]`)
6. Optionally cleans up the test clip after

## Filename Format

The scripts parse recording filenames automatically. Expected format from WoW recording addon:

```
2026-04-01 21-55-01 - Gyt - Chimaerus the Undreamt God [M] (Kill).mp4
{date}    {time}    {player}  {encounter name}       {diff} {result}
```

| Tag | Difficulty |
|-----|-----------|
| `[M]` | Mythic |
| `[HC]` | Heroic |
| `[N]` | Normal |

Result is typically `(Kill)` or `(Wipe)`. Files with unrecognized names still process — they just use the raw filename as the YouTube title.

### Generated YouTube Metadata

**Title:** `Mythic Chimaerus the Undreamt God - Lusting on Trash - Tank PoV`

**Description:**
```
Mythic Chimaerus the Undreamt God
Killed April 1, 2026

Gyt - Prot Warrior Tank PoV
Lusting on Trash - Area-52

Lusting on Trash is always recruiting skilled players.
Apply: http://www.lustingontrash.com/
```

Videos are uploaded as **private** (review before publishing), marked **not made for kids**, and added to the configured playlist.

## YouTube API Setup

One-time setup to enable uploads:

### 1. Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click the project dropdown at the top, then **New Project**
3. Name it (e.g., "WoW Video Uploader") and create it

### 2. Enable the YouTube Data API

1. Go to [API Library](https://console.cloud.google.com/apis/library)
2. Search for **YouTube Data API v3**
3. Click it and press **Enable**

### 3. Configure OAuth Consent Screen

1. Go to [OAuth Consent](https://console.cloud.google.com/apis/credentials/consent)
2. Choose **External** user type
3. Fill in app name, support email, and developer contact email
4. On the **Test users** page, add your own Google email
5. Save through the remaining steps

### 4. Create OAuth Credentials

1. Go to [Credentials](https://console.cloud.google.com/apis/credentials)
2. Click **+ Create Credentials** > **OAuth client ID**
3. Application type: **Desktop app**
4. Click **Create**, then **Download JSON**
5. Save the file as `client_secret.json` in this project's root directory

### 5. Authorize

```bash
pnpm run test
```

Your browser will open for Google sign-in. Select both permissions (upload + view). After authorizing, the token is saved locally. If you have multiple YouTube channels, you'll be prompted to pick one.

> **Note:** While the app is in "Testing" mode in Google Cloud, the OAuth token expires every 7 days. You can publish the app (no review needed for personal use) to remove this limitation.

## Configuration

Edit `config.json` to change guild info, YouTube defaults, or playlist:

```json
{
  "guild": "Lusting on Trash",
  "server": "Area-52",
  "role": "Tank PoV",
  "class": "Prot Warrior",
  "applyUrl": "http://www.lustingontrash.com/",
  "recruitMessage": "Lusting on Trash is always recruiting skilled players.",
  "playlistId": "PLdWi4naLwd81OAI1WGzZg45EKTJO3KX49",
  "privacy": "private",
  "madeForKids": false,
  "category": "20",
  "tags": ["World of Warcraft", "WoW", "Gaming", "Prot Warrior", "Tank"]
}
```

- **`playlistId`**: Get from the YouTube playlist URL (`list=` parameter). Leave empty to skip playlist assignment.
- **`privacy`**: `private`, `unlisted`, or `public`.

## Encoding Details

- **Crop:** Center crop from 3840x1600 to 2560x1440 (native 1440p, no scaling)
- **Codec:** H.264 High profile, Level 4.2
- **Quality:** CRF 18, slow preset (quality over speed)
- **Audio:** AAC 192kbps
- **Container:** MP4 with faststart (optimized for streaming)

## File Tracking

| File | Purpose | Reset by |
|------|---------|----------|
| `uploaded.json` | Maps filenames → YouTube video IDs | Delete an entry to re-upload that file |
| `channel.json` | Saved YouTube channel selection | Delete to re-pick channel |
| `token.json` | OAuth token | Delete to re-authorize (expires every 7 days in Testing mode) |

All tracking files are gitignored.

## Project Structure

```
process_videos/
├── config.json              # YouTube/guild defaults
├── package.json
├── tsconfig.json
├── src/
│   ├── all.ts               # Pipelined process + upload (main entry point)
│   ├── process.ts           # Standalone crop + encode
│   ├── upload.ts            # Standalone YouTube upload
│   ├── test.ts              # Test mode (15s clip + optional upload)
│   ├── parse-filename.ts    # Filename parser + metadata generators
│   └── upload-progress.ts   # Upload speed/ETA tracker (5s rolling window)
├── input/                   # Drop source recordings here
└── output/                  # Processed videos land here
```
