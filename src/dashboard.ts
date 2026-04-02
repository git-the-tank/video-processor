import logUpdate from "log-update";
import chalk from "chalk";

// --- State types ---

export type EncodeState =
  | { status: "pending" }
  | { status: "active"; progress: string }
  | { status: "done"; elapsed: string }
  | { status: "skipped" }
  | { status: "error"; message: string };

export type UploadState =
  | { status: "pending" }
  | { status: "queued" }
  | { status: "active"; pct: number; speed: string; eta: string }
  | { status: "done"; url: string; elapsed: string }
  | { status: "skipped" }
  | { status: "not-applicable" }
  | { status: "error"; message: string };

export interface FileEntry {
  displayName: string;
  encode: EncodeState;
  upload: UploadState;
}

// --- Module state ---

let files: FileEntry[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let headerLine = "";
let nameWidth = 0;
const ENCODE_COL_WIDTH = 22;

// --- Public API ---

export function initDashboard(entries: FileEntry[], header: string) {
  files = entries;
  headerLine = header;
  nameWidth = Math.max(4, ...files.map((f) => f.displayName.length));
  timer = setInterval(() => logUpdate(renderTable()), 250);
}

export function updateEncode(index: number, state: EncodeState) {
  files[index].encode = state;
}

export function updateUpload(index: number, state: UploadState) {
  files[index].upload = state;
}

export function stopDashboard() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  logUpdate(renderTable());
  logUpdate.done();
}

// --- Rendering ---

function bar(pct: number, width = 8): string {
  const filled = Math.round((pct / 100) * width);
  return "\u2588".repeat(filled) + "\u2591".repeat(width - filled);
}

function formatEncode(state: EncodeState): string {
  switch (state.status) {
    case "pending":
      return chalk.dim("queued");
    case "active":
      return chalk.yellow(state.progress);
    case "done":
      return chalk.green(`done (${state.elapsed})`);
    case "skipped":
      return chalk.green("already done");
    case "error":
      return chalk.red(`error: ${state.message}`);
  }
}

function formatUpload(state: UploadState): string {
  switch (state.status) {
    case "pending":
      return chalk.dim("--");
    case "queued":
      return chalk.dim("queued");
    case "active": {
      const b = chalk.cyan(bar(state.pct));
      return `${b} ${chalk.yellow(`${state.pct.toFixed(1)}%`)} ${state.speed} ETA ${state.eta}`;
    }
    case "done":
      return chalk.green(`done (${state.elapsed})`);
    case "skipped":
      return chalk.green("already done");
    case "not-applicable":
      return chalk.dim("--");
    case "error":
      return chalk.red(`error: ${state.message}`);
  }
}

function renderTable(): string {
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - stripAnsi(s).length));

  const lines: string[] = [];
  lines.push(headerLine);
  lines.push("");

  const hFile = pad("File", nameWidth);
  const hEncode = pad("Encode", ENCODE_COL_WIDTH);
  const hUpload = "Upload";
  lines.push(`  ${chalk.bold(hFile)}  ${chalk.bold(hEncode)}  ${chalk.bold(hUpload)}`);
  lines.push(chalk.dim("  " + "\u2500".repeat(nameWidth + ENCODE_COL_WIDTH + 30)));

  for (const f of files) {
    const name = pad(f.displayName, nameWidth);
    const enc = pad(formatEncode(f.encode), ENCODE_COL_WIDTH);
    const upl = formatUpload(f.upload);
    lines.push(`  ${name}  ${enc}  ${upl}`);
  }

  return lines.join("\n");
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
