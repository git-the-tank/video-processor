import type { VideoMetadata } from "./parse-filename.js";

export interface WclConfig {
  guildName: string;
  serverSlug: string;
  serverRegion: string;
}

export interface ChapterMarker {
  timeSeconds: number;
  label: string;
}

interface WclToken {
  accessToken: string;
  expiresAt: number;
}

const WCL_DIFFICULTY: Record<string, number> = {
  Mythic: 5,
  Heroic: 4,
  Normal: 3,
};

let cachedToken: WclToken | null = null;

async function authenticate(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.accessToken;
  }

  const clientId = process.env.WCL_CLIENT_ID;
  const clientSecret = process.env.WCL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("WCL_CLIENT_ID and WCL_CLIENT_SECRET must be set in .env");
  }

  const res = await fetch("https://www.warcraftlogs.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) {
    throw new Error(`WCL auth failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };

  cachedToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  return cachedToken.accessToken;
}

async function queryWcl(token: string, query: string, variables: Record<string, unknown>): Promise<unknown> {
  const res = await fetch("https://www.warcraftlogs.com/api/v2/client", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`WCL API error: ${res.status} ${await res.text()}`);
  }

  const json = (await res.json()) as { data?: unknown; errors?: { message: string }[] };
  if (json.errors?.length) {
    throw new Error(`WCL GraphQL error: ${json.errors.map((e) => e.message).join(", ")}`);
  }

  return json.data;
}

interface WclReport {
  code: string;
  title: string;
  startTime: number;
  endTime: number;
}

interface WclPhaseTransition {
  id: number;
  startTime: number;
}

interface WclFight {
  id: number;
  name: string;
  encounterID: number;
  difficulty: number;
  kill: boolean;
  startTime: number;
  endTime: number;
  phaseTransitions: WclPhaseTransition[] | null;
}

const REPORTS_QUERY = `
  query GuildReports($guildName: String!, $serverSlug: String!, $serverRegion: String!, $startTime: Float!, $endTime: Float!) {
    reportData {
      reports(guildName: $guildName, guildServerSlug: $serverSlug, guildServerRegion: $serverRegion, startTime: $startTime, endTime: $endTime) {
        data {
          code
          title
          startTime
          endTime
        }
      }
    }
  }
`;

const FIGHTS_QUERY = `
  query ReportFights($reportCode: String!) {
    reportData {
      report(code: $reportCode) {
        fights(translate: true) {
          id
          name
          encounterID
          difficulty
          kill
          startTime
          endTime
          phaseTransitions {
            id
            startTime
          }
        }
      }
    }
  }
`;

async function findReports(token: string, config: WclConfig, date: Date): Promise<WclReport[]> {
  // Search the full day (UTC) of the video date
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);

  const data = (await queryWcl(token, REPORTS_QUERY, {
    guildName: config.guildName,
    serverSlug: config.serverSlug,
    serverRegion: config.serverRegion,
    startTime: dayStart.getTime(),
    endTime: dayEnd.getTime(),
  })) as { reportData: { reports: { data: WclReport[] } } };

  return data.reportData.reports.data;
}

async function findFights(token: string, reportCode: string): Promise<WclFight[]> {
  const data = (await queryWcl(token, FIGHTS_QUERY, {
    reportCode,
  })) as { reportData: { report: { fights: WclFight[] } } };

  return data.reportData.report.fights;
}

function matchFight(
  fights: WclFight[],
  meta: VideoMetadata
): WclFight | null {
  const targetDifficulty = WCL_DIFFICULTY[meta.difficulty];
  const isKill = meta.result === "Kill";

  const candidates = fights.filter(
    (f) =>
      f.encounterID > 0 &&
      f.name.toLowerCase() === meta.encounterName.toLowerCase() &&
      f.difficulty === targetDifficulty &&
      f.kill === isKill
  );

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // Disambiguate by closest start time to the recording time
  const recordingEpoch = meta.date.getTime();
  candidates.sort(
    (a, b) =>
      Math.abs(a.startTime - recordingEpoch) -
      Math.abs(b.startTime - recordingEpoch)
  );

  return candidates[0];
}

function buildChapters(fight: WclFight): ChapterMarker[] | null {
  const phases = fight.phaseTransitions;
  if (!phases || phases.length === 0) return null;

  const chapters: ChapterMarker[] = [{ timeSeconds: 0, label: "Phase 1" }];

  let phaseNumber = 1;
  for (let i = 0; i < phases.length; i++) {
    // Phase timestamps are relative to report start; convert to fight-relative
    const fightRelativeMs = phases[i].startTime - fight.startTime;
    // Video starts 1s before combat, so add 1
    const videoSeconds = fightRelativeMs / 1000 + 1;

    // Skip Phase 1 at fight start (redundant with "Pull")
    if (videoSeconds < 2) continue;

    // Determine phase duration to detect intermissions
    const nextStart = i + 1 < phases.length ? phases[i + 1].startTime : fight.endTime;
    const durationMs = nextStart - phases[i].startTime;
    const isIntermission = durationMs < 60_000;

    if (isIntermission) {
      chapters.push({ timeSeconds: videoSeconds, label: "Intermission" });
    } else {
      phaseNumber++;
      chapters.push({ timeSeconds: videoSeconds, label: `Phase ${phaseNumber}` });
    }
  }

  // Add "Boss Defeated" at fight end (for kills)
  if (fight.kill) {
    const killSeconds = (fight.endTime - fight.startTime) / 1000 + 1;
    chapters.push({ timeSeconds: killSeconds, label: "Boss Defeated" });
  }

  // YouTube requires at least 3 chapters
  if (chapters.length < 3) return null;

  // Ensure minimum 10s gaps
  const filtered: ChapterMarker[] = [chapters[0]];
  for (let i = 1; i < chapters.length; i++) {
    if (chapters[i].timeSeconds - filtered[filtered.length - 1].timeSeconds >= 10) {
      filtered.push(chapters[i]);
    }
  }

  if (filtered.length < 3) return null;

  return filtered;
}

export function formatChapters(chapters: ChapterMarker[]): string {
  return chapters
    .map((ch) => {
      const mins = Math.floor(ch.timeSeconds / 60);
      const secs = Math.floor(ch.timeSeconds % 60);
      return `${mins}:${secs.toString().padStart(2, "0")} ${ch.label}`;
    })
    .join("\n");
}

export async function getChapters(
  wclConfig: WclConfig,
  meta: VideoMetadata
): Promise<ChapterMarker[] | null> {
  const token = await authenticate();

  const reports = await findReports(token, wclConfig, meta.date);
  if (reports.length === 0) return null;

  // Search all reports for the matching fight
  for (const report of reports) {
    const fights = await findFights(token, report.code);
    const fight = matchFight(fights, meta);
    if (fight) {
      return buildChapters(fight);
    }
  }

  return null;
}
