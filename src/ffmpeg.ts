import { execFile } from "node:child_process";
import { videoEncodeArgs, videoLevel } from "./encoder.js";

interface EncodeOptions {
  onProgress?: (info: string) => void;
  startTime?: number;
  duration?: number;
}

export function runEncode(
  inputPath: string,
  outputPath: string,
  options?: EncodeOptions
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args: string[] = [];

    if (options?.startTime != null) {
      args.push("-ss", options.startTime.toString());
    }

    args.push("-i", inputPath);

    if (options?.duration != null) {
      args.push("-t", options.duration.toString());
    }

    args.push(
      "-vf", "crop=2844:1600:498:0,scale=2560:1440",
      ...videoEncodeArgs,
      "-profile:v", "high",
      "-level", videoLevel,
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "192k",
      "-movflags", "+faststart",
      "-y",
      outputPath,
    );

    const proc = execFile("ffmpeg", args, { maxBuffer: 10 * 1024 * 1024 });

    proc.stderr?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line.startsWith("frame=")) {
        if (options?.onProgress) {
          const timeMatch = line.match(/time=(\S+)/);
          const speedMatch = line.match(/speed=(\S+)/);
          const time = timeMatch?.[1] ?? "?";
          const speed = speedMatch?.[1] ?? "?";
          options.onProgress(`${time} @ ${speed}`);
        } else {
          process.stdout.write(`\r  ${line.slice(0, 80)}`);
        }
      }
    });

    proc.on("close", (code) => {
      if (!options?.onProgress) process.stdout.write("\n");
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });

    proc.on("error", reject);
  });
}

export function getDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filePath],
      (err, stdout) => {
        if (err) return reject(err);
        resolve(parseFloat(stdout.trim()));
      }
    );
  });
}
