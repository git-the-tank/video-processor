let encodeStatus = "";
let uploadStatus = "";
let timer: ReturnType<typeof setInterval> | null = null;

function render() {
  const parts: string[] = [];
  if (encodeStatus) parts.push(encodeStatus);
  if (uploadStatus) parts.push(uploadStatus);
  if (parts.length === 0) return;
  process.stdout.write(`\r\x1b[K  ${parts.join(" | ")}`);
}

export function setEncode(s: string) {
  encodeStatus = s;
}

export function setUpload(s: string) {
  uploadStatus = s;
}

/** Clear status line, print a log message, then let the interval redraw. */
export function log(msg: string) {
  process.stdout.write(`\r\x1b[K`);
  console.log(msg);
}

export function startStatus() {
  if (timer) return;
  timer = setInterval(render, 250);
}

export function clearStatus() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  encodeStatus = "";
  uploadStatus = "";
  process.stdout.write(`\r\x1b[K`);
}
