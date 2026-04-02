# WoW Video Processor

Automated pipeline for cropping ultrawide WoW recordings to 16:9 and uploading to YouTube with auto-generated metadata. Uses ffmpeg for video processing and the YouTube Data API v3 for uploads.

## Commands

| Command | Description |
|---------|-------------|
| `pnpm run all` | **Recommended.** Pipelined encode + upload. Overlaps encoding and uploading for throughput. |
| `pnpm run process` | Encode only — crop all videos in `input/` → `output/` |
| `pnpm run upload` | Upload only — upload all videos in `output/` to YouTube |
| `pnpm run upload -- --file "name.mp4"` | Upload a specific file |
| `pnpm run test` | Test mode — 15s clip from middle, crop, preview metadata, optionally upload |

## Architecture

```
src/
├── all.ts              # Pipelined process + upload (main entry point)
├── process.ts          # Standalone encode script
├── upload.ts           # Standalone upload script
├── test.ts             # Test mode (15s clip + optional upload)
├── parse-filename.ts   # Filename regex parser + YouTube metadata generators
└── upload-progress.ts  # Rolling-window upload speed/ETA tracker
```

### Pipeline behavior (`pnpm run all`)
- Encodes are serial (CPU-bound), uploads are serial (network-bound)
- They overlap: V1 uploads while V2 encodes
- Skips files already encoded (exist in `output/`) or already uploaded (in `uploaded.json`)
- Files in `output/` with no `uploaded.json` record are uploaded without re-encoding (retry behavior)
- Works without YouTube credentials (encode-only mode if no `client_secret.json`)

## Video Settings
- **Source:** 3840x1600 @ 60fps (ultrawide WoW recordings)
- **Output:** 2560x1440 (1440p) — crop sides + scale height: `crop=2844:1600:498:0,scale=2560:1440`
- **Codec:** H.264 High profile, Level 5.1 (GPU) / 4.2 (CPU), CQ/CRF 18
- **Audio:** AAC 192kbps
- **Container:** MP4 with faststart

## Filename Format
Recordings are auto-named by WoW recording addon:
```
2026-04-01 21-55-01 - Gyt - Chimaerus the Undreamt God [M] (Kill).mp4
{date}    {time}    {player} {encounter}              {diff} {result}
```
- Difficulty: `[M]` = Mythic, `[HC]` = Heroic, `[N]` = Normal
- Result: `(Kill)` or `(Wipe)`
- Player name (Gyt) is the recording character

## YouTube Metadata (all deterministic from filename + config)
- **Title:** `{Difficulty} {Encounter} - {Guild} - {Role}`
- **Description:** Encounter name, formatted kill date, player/class/role, guild info, recruitment message
- **Privacy:** Private (review before publishing)
- **Made for kids:** No
- **Category:** 20 (Gaming)
- **Playlist:** Configured by ID in `config.json` (currently "Midnight Raids Season 1")
- No angle brackets `<>` in descriptions — YouTube rejects them

## Config (`config.json`)
Guild info, YouTube defaults, playlist ID. Privacy defaults to `private`. Playlist ID comes from the `list=` URL parameter on YouTube. Leave `playlistId` empty to skip playlist assignment.

## OAuth Scopes
- `youtube.upload` — upload videos
- `youtube.readonly` — list channels/playlists
- `youtube.force-ssl` — add videos to playlists

## Tracking Files (all gitignored)
- `uploaded.json` — maps filenames to YouTube video IDs. Delete an entry to re-upload.
- `channel.json` — saved YouTube channel selection. Delete to re-pick.
- `token.json` — OAuth token. Delete to re-authorize. Expires every 7 days in Google Cloud "Testing" mode.
- `client_secret.json` — OAuth credentials from Google Cloud Console.

## Runtime
- Node 24, pnpm, TypeScript via tsx
- ffmpeg + ffprobe must be in PATH
