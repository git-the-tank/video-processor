const useCpu = process.env.ENCODE_CPU === "1";

export const videoEncodeArgs: string[] = useCpu
  ? ["-c:v", "libx264",    "-preset", "slow", "-crf", "18"]
  : ["-c:v", "h264_nvenc", "-preset", "p7",   "-cq",  "18"];

export const videoLevel = useCpu ? "4.2" : "5.1";

console.log(`  Encoder: ${useCpu ? "libx264 (CPU)" : "h264_nvenc (GPU)"}`);
