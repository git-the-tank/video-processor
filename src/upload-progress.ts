const WINDOW_SECONDS = 5;

interface Sample {
  time: number;
  bytes: number;
}

export function createProgressTracker(
  fileSize: number,
  onProgress: (pct: number, speed: string, eta: string) => void
) {
  const samples: Sample[] = [];

  return (evt: { bytesRead: number }) => {
    const now = Date.now();
    samples.push({ time: now, bytes: evt.bytesRead });

    // Trim samples outside the window
    const cutoff = now - WINDOW_SECONDS * 1000;
    while (samples.length > 1 && samples[0].time < cutoff) {
      samples.shift();
    }

    const pct = (evt.bytesRead / fileSize) * 100;

    let speedStr = "---";
    let etaStr = "---";

    if (samples.length >= 2) {
      const first = samples[0];
      const elapsed = (now - first.time) / 1000;
      if (elapsed > 0.1) {
        const bytesPerSec = (evt.bytesRead - first.bytes) / elapsed;
        const mbps = bytesPerSec / 1024 / 1024;
        speedStr = `${mbps.toFixed(1)} MB/s`;

        const remaining = fileSize - evt.bytesRead;
        if (bytesPerSec > 0) {
          const etaSec = remaining / bytesPerSec;
          if (etaSec < 60) {
            etaStr = `${Math.ceil(etaSec)}s`;
          } else {
            const min = Math.floor(etaSec / 60);
            const sec = Math.ceil(etaSec % 60);
            etaStr = `${min}m${sec}s`;
          }
        }
      }
    }

    onProgress(pct, speedStr, etaStr);
  };
}
