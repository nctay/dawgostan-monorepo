import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type ProcessOptions = { timeoutMs: number };
type TranscodeOptions = ProcessOptions & { targetBytes?: number };

export function fitTelegramPhotoDimensions(width: number, height: number) {
  let canvasWidth = width;
  let canvasHeight = height;
  if (width / height > 20) canvasHeight = Math.ceil(width / 20);
  if (height / width > 20) canvasWidth = Math.ceil(height / 20);

  const scale = Math.min(1, 9_999 / (canvasWidth + canvasHeight));
  canvasWidth = Math.max(1, Math.floor(canvasWidth * scale));
  canvasHeight = Math.max(1, Math.floor(canvasHeight * scale));
  if (canvasWidth / canvasHeight > 20) canvasHeight = Math.ceil(canvasWidth / 20);
  if (canvasHeight / canvasWidth > 20) canvasWidth = Math.ceil(canvasHeight / 20);
  return {
    contentWidth: Math.max(1, Math.floor(width * scale)),
    contentHeight: Math.max(1, Math.floor(height * scale)),
    canvasWidth,
    canvasHeight,
  };
}

export async function normalizePhotoForTelegram(
  inputPath: string,
  mimeType: string | undefined,
  options: ProcessOptions,
): Promise<{ filePath: string; mimeType: string | undefined }> {
  const { stdout } = await execFileAsync("magick", ["identify", "-format", "%w %h", `${inputPath}[0]`], {
    timeout: Math.min(options.timeoutMs, 10_000),
  });
  const [rawWidth, rawHeight] = stdout.trim().split(/\s+/);
  const width = Number(rawWidth);
  const height = Number(rawHeight);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error("ImageMagick returned invalid image dimensions");
  }

  const fitted = fitTelegramPhotoDimensions(width, height);
  if (fitted.contentWidth === width && fitted.contentHeight === height && fitted.canvasWidth === width && fitted.canvasHeight === height) {
    return { filePath: inputPath, mimeType };
  }

  const outputMimeType = mimeType?.split(";")[0]?.trim().toLowerCase() === "image/jpeg" ? "image/jpeg" : "image/png";
  const outputPath = path.join(os.tmpdir(), `dawgostan-image-${crypto.randomUUID()}.${outputMimeType === "image/jpeg" ? "jpg" : "png"}`);
  const args = [inputPath, "-resize", `${fitted.contentWidth}x${fitted.contentHeight}!`];
  if (fitted.contentWidth !== fitted.canvasWidth || fitted.contentHeight !== fitted.canvasHeight) {
    args.push("-background", "white", "-gravity", "center", "-extent", `${fitted.canvasWidth}x${fitted.canvasHeight}`);
  }
  args.push(outputPath);
  console.log(`[image] resizing for Telegram input=${width}x${height} output=${fitted.canvasWidth}x${fitted.canvasHeight}`);
  try {
    await runProcess("magick", args, options.timeoutMs);
    return { filePath: outputPath, mimeType: outputMimeType };
  } catch (error) {
    await fs.promises.rm(outputPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function convertAnimatedWebpToMp4(inputPath: string, outputPath: string, options: ProcessOptions): Promise<void> {
  try {
    await runProcess("magick", [inputPath, "-coalesce", outputPath], options.timeoutMs);
  } catch (error) {
    await fs.promises.rm(outputPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function transcodeForTelegram(inputPath: string, outputPath: string, options: TranscodeOptions): Promise<void> {
  try {
    const baseArgs = [
      "-hide_banner",
      "-y",
      "-i",
      inputPath,
      "-map",
      "0:v:0",
      "-sn",
      "-dn",
      "-vf",
      "scale=trunc((iw*sar)/2)*2:trunc(ih/2)*2,setsar=1,format=yuv420p",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-profile:v",
      "main",
    ];

    if (options.targetBytes) {
      const duration = await readVideoDuration(inputPath, options.timeoutMs);
      const audioBitrate = 128_000;
      const videoBitrate = Math.max(100_000, Math.floor((options.targetBytes * 8 * 0.98) / duration) - audioBitrate);
      const passDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dawgostan-ffmpeg-pass-"));
      const passLog = path.join(passDir, "pass");
      try {
        await runProcess("ffmpeg", [...baseArgs, "-b:v", String(videoBitrate), "-pass", "1", "-passlogfile", passLog, "-an", "-f", "mp4", os.devNull], options.timeoutMs);
        await runProcess(
          "ffmpeg",
          [
            ...baseArgs,
            "-b:v",
            String(videoBitrate),
            "-pass",
            "2",
            "-passlogfile",
            passLog,
            "-map",
            "0:a?",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-movflags",
            "+faststart",
            outputPath,
          ],
          options.timeoutMs,
        );
      } finally {
        await fs.promises.rm(passDir, { force: true, recursive: true }).catch(() => undefined);
      }
      return;
    }

    await runProcess(
      "ffmpeg",
      [...baseArgs, "-crf", "28", "-map", "0:a?", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", outputPath],
      options.timeoutMs,
    );
  } catch (error) {
    await fs.promises.rm(outputPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readVideoDuration(filePath: string, timeoutMs: number): Promise<number> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath],
    { timeout: timeoutMs },
  );
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("ffprobe returned an invalid video duration");
  return duration;
}

async function runProcess(command: "ffmpeg" | "magick", args: string[], timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], signal: controller.signal });
      const stderr: Buffer[] = [];
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", reject);
      child.on("close", (code, signal) => {
        const message = Buffer.concat(stderr).toString("utf8").trim();
        if (code === 0) resolve();
        else reject(new Error(`${command} failed${signal ? ` (${signal})` : ""}: ${message || `exit code ${code}`}`));
      });
    });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${command} timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
