import path from "node:path";

export interface VideoMetadata {
  date: Date;
  playerName: string;
  encounterName: string;
  difficulty: "Mythic" | "Heroic" | "Normal";
  difficultyTag: string;
  result: string;
  originalFilename: string;
}

const DIFFICULTY_MAP: Record<string, VideoMetadata["difficulty"]> = {
  M: "Mythic",
  HC: "Heroic",
  N: "Normal",
};

const FILENAME_REGEX =
  /^(\d{4}-\d{2}-\d{2})\s+\d{2}-\d{2}-\d{2}\s+-\s+(.+?)\s+-\s+(.+?)\s+\[(M|HC|N)\]\s+\((\w+)\)/;

export function parseFilename(filename: string): VideoMetadata | null {
  const basename = path.basename(filename, path.extname(filename));
  const match = basename.match(FILENAME_REGEX);
  if (!match) return null;

  const [, dateStr, playerName, encounterName, difficultyTag, result] = match;

  return {
    date: new Date(dateStr + "T00:00:00"),
    playerName,
    encounterName,
    difficulty: DIFFICULTY_MAP[difficultyTag],
    difficultyTag,
    result,
    originalFilename: filename,
  };
}

export function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function generateTitle(
  meta: VideoMetadata,
  config: { guild: string; role: string }
): string {
  return `${meta.difficulty} ${meta.encounterName} - ${config.guild} - ${config.role}`;
}

export function generateDescription(
  meta: VideoMetadata,
  config: {
    guild: string;
    server: string;
    role: string;
    class: string;
    applyUrl: string;
    recruitMessage: string;
  }
): string {
  const resultVerb = meta.result === "Kill" ? "Killed" : meta.result;
  return [
    `${meta.difficulty} ${meta.encounterName}`,
    `${resultVerb} ${formatDate(meta.date)}`,
    "",
    `${meta.playerName} - ${config.class} ${config.role}`,
    `${config.guild} - ${config.server}`,
    "",
    config.recruitMessage,
    `Apply: ${config.applyUrl}`,
  ].join("\n");
}
