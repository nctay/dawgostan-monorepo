import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
type NudityScores = { nude: number; nipples: number };
type Prediction = { className: string; probability: number };

export type NsfwConfig = {
  ensembleClassifierUrl?: string;
  ensembleThreshold: number;
  maxFrames: number;
  requestTimeoutMs?: number;
};

export type LegacyNsfwConfig = {
  classifierUrl?: string;
  nsfwjsClassifierUrl: string;
  nudeThreshold: number;
  nipplesThreshold: number;
  nsfwjsSpoilerThreshold: number;
  maxFrames: number;
  requestTimeoutMs?: number;
};

export type NsfwResult = {
  publicSpoiler: boolean;
  owenScore?: number;
  siglipScore?: number;
  nudeScore?: number;
  nipplesScore?: number;
  nsfwjsClassName?: string;
  nsfwjsScore?: number;
  status: "disabled" | "ok" | "error";
};

export async function classifyNsfw(
  filePath: string,
  mediaType: "image" | "video",
  animated: boolean,
  config: NsfwConfig,
): Promise<NsfwResult> {
  if (!config.ensembleClassifierUrl) return { publicSpoiler: false, status: "disabled" };

  const timeoutMs = config.requestTimeoutMs ?? 30_000;
  const frameDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dawgostan-nsfw-"));
  try {
    const maxFrames = framesToCheck(mediaType, animated, config.maxFrames);
    let publicSpoiler = false;
    let highestOwen = 0;
    let highestSiglip = 0;
    for await (const frame of ensembleFrames(filePath, frameDir, maxFrames, mediaType, timeoutMs)) {
      const response = await fetch(config.ensembleClassifierUrl, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: await fs.promises.readFile(frame),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`NSFW ensemble returned ${response.status}`);
      const body = (await response.json()) as { owen?: unknown; siglip?: unknown };
      if (!validScore(body.owen) || !validScore(body.siglip)) throw new Error("NSFW ensemble returned invalid scores");
      highestOwen = Math.max(highestOwen, body.owen);
      highestSiglip = Math.max(highestSiglip, body.siglip);
      publicSpoiler = shouldSpoilerEnsemble(highestOwen, highestSiglip, config.ensembleThreshold);
      if (publicSpoiler) break;
    }
    return {
      publicSpoiler,
      owenScore: highestOwen,
      siglipScore: highestSiglip,
      status: "ok",
    };
  } catch (error) {
    console.error(`[nsfw] ensemble classification failed; enabling public spoiler error=${error instanceof Error ? error.message : String(error)}`);
    return { publicSpoiler: true, status: "error" };
  } finally {
    await fs.promises.rm(frameDir, { force: true, recursive: true }).catch(() => undefined);
  }
}

export function framesToCheck(mediaType: "image" | "video", animated: boolean, maxFrames: number): number {
  return mediaType === "video" || animated ? maxFrames : 1;
}

export function shouldSpoilerEnsemble(owenScore: number, siglipScore: number, threshold: number): boolean {
  return owenScore >= threshold || siglipScore >= threshold;
}

export async function classifyLegacyNsfw(
  filePath: string,
  mediaType: "image" | "video",
  animated: boolean,
  config: LegacyNsfwConfig,
): Promise<NsfwResult> {
  if (mediaType === "video" || !config.classifierUrl) return { publicSpoiler: false, status: "disabled" };

  const timeoutMs = config.requestTimeoutMs ?? 30_000;
  const frameDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dawgostan-nsfw-"));
  try {
    const maxFrames = animated ? config.maxFrames : 1;
    const frames = await extractFrames(filePath, path.join(frameDir, "wd"), maxFrames, false, timeoutMs);
    let highest: NudityScores = { nude: 0, nipples: 0 };

    for (const frame of frames) {
      const response = await fetch(config.classifierUrl, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: await fs.promises.readFile(frame),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`classifier returned ${response.status}`);
      const body = (await response.json()) as unknown;
      if (!validNudityScores(body)) throw new Error("classifier returned invalid nudity scores");
      highest = { nude: Math.max(highest.nude, body.nude), nipples: Math.max(highest.nipples, body.nipples) };
    }

    const nsfwjsFrames = await extractFrames(filePath, path.join(frameDir, "nsfwjs"), maxFrames, true, timeoutMs);
    let highestHard: Prediction | undefined;
    for (const frame of nsfwjsFrames) {
      const response = await fetch(config.nsfwjsClassifierUrl, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: await fs.promises.readFile(frame),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`NSFWJS classifier returned ${response.status}`);
      const body = (await response.json()) as { prediction?: unknown };
      if (!Array.isArray(body.prediction)) throw new Error("NSFWJS classifier returned invalid predictions");
      const candidate = highestHardNsfwPrediction(body.prediction);
      if (!candidate) throw new Error("NSFWJS classifier returned no Porn or Hentai score");
      if (!highestHard || candidate.probability > highestHard.probability) highestHard = candidate;
    }

    return {
      publicSpoiler: shouldSpoiler(highest, highestHard?.probability ?? 0, config),
      nudeScore: highest.nude,
      nipplesScore: highest.nipples,
      nsfwjsClassName: highestHard?.className,
      nsfwjsScore: highestHard?.probability,
      status: "ok",
    };
  } catch (error) {
    console.error(`[nsfw] classification failed; enabling public spoiler error=${error instanceof Error ? error.message : String(error)}`);
    return { publicSpoiler: true, status: "error" };
  } finally {
    await fs.promises.rm(frameDir, { force: true, recursive: true }).catch(() => undefined);
  }
}

export function shouldSpoiler(
  scores: NudityScores,
  nsfwjsScore: number,
  thresholds: Pick<LegacyNsfwConfig, "nudeThreshold" | "nipplesThreshold" | "nsfwjsSpoilerThreshold">,
): boolean {
  return (
    scores.nude >= thresholds.nudeThreshold ||
    scores.nipples >= thresholds.nipplesThreshold ||
    nsfwjsScore >= thresholds.nsfwjsSpoilerThreshold
  );
}

export function highestHardNsfwPrediction(predictions: unknown[]): Prediction | undefined {
  return predictions
    .filter(validPrediction)
    .filter((prediction) => prediction.className === "Porn" || prediction.className === "Hentai")
    .reduce<Prediction | undefined>((highest, prediction) => (!highest || prediction.probability > highest.probability ? prediction : highest), undefined);
}

export function frameFilters(maxFrames: number, duration: number, nsfwjs: boolean): string[] {
  return [
    ...(maxFrames > 1 ? [`fps=${duration > 0 ? maxFrames / duration : 1}`] : []),
    ...(nsfwjs ? ["scale=224:224:force_original_aspect_ratio=decrease", ...(maxFrames === 1 ? ["pad=224:224:(ow-iw)/2:(oh-ih)/2"] : [])] : []),
  ];
}

async function* ensembleFrames(filePath: string, outputDir: string, maxFrames: number, mediaType: "image" | "video", timeoutMs: number) {
  const duration = maxFrames > 1 ? await readDuration(filePath, timeoutMs) : 0;
  if (mediaType === "video" && duration > 0) {
    let foundFrame = false;
    for (let index = 0; index < maxFrames; index += 1) {
      const timestamp = (duration * index) / maxFrames;
      const output = path.join(outputDir, `frame-${String(index + 1).padStart(2, "0")}.jpg`);
      await execFileAsync(
        "ffmpeg",
        ["-v", "error", "-ss", String(timestamp), "-i", filePath, "-frames:v", "1", "-q:v", "1", output],
        { timeout: timeoutMs },
      );
      // A seek past the last decodable frame can succeed without producing a JPEG.
      if (fs.existsSync(output)) {
        foundFrame = true;
        yield output;
      }
    }
    if (!foundFrame) throw new Error("ffmpeg extracted no frames");
    return;
  }

  if (maxFrames > 1) {
    const fps = frameFilters(maxFrames, duration, false);
    // Batches of 1, 1, 2, 4, ... keep early hits cheap without restarting the decoder for every sample.
    let start = 0;
    while (start < maxFrames) {
      const count = Math.min(Math.max(1, start), maxFrames - start);
      const filters = [...fps, `trim=start_frame=${start}`, "setpts=PTS-STARTPTS", "format=yuvj420p|yuvj422p|yuvj444p"];
      // Explicit full-range JPEG formats also let ffmpeg finish successfully when trim reaches EOF.
      await execFileAsync("ffmpeg", [
        "-v", "error", "-xerror", "-i", filePath, "-vf", filters.join(","), "-frames:v", String(count),
        "-q:v", "1", "-start_number", String(start + 1), path.join(outputDir, "frame-%02d.jpg"),
      ], { timeout: timeoutMs });
      const frames = (await frameFiles(outputDir)).slice(start);
      if (start === 0 && frames.length === 0) {
        if (duration > 0) throw new Error("ffmpeg extracted no frames");
        break;
      }
      yield* frames;
      if (frames.length < count) return;
      start += count;
    }
    if (start > 0) return;
  }

  // A valid subsecond clip with unknown duration can end before fps=1 emits any sample.
  const first = path.join(outputDir, "first.jpg");
  await execFileAsync("ffmpeg", ["-v", "error", "-xerror", "-i", filePath, "-frames:v", "1", "-q:v", "1", first], { timeout: timeoutMs });
  yield first;
}

async function writeFrames(filePath: string, output: string, filters: string[], count: number, nsfwjs: boolean, timeoutMs: number) {
  await execFileAsync("ffmpeg", [
    "-v", "error", "-i", filePath, "-vf", filters.join(",") || "null", "-frames:v", String(count), "-q:v", nsfwjs ? "4" : "1", output,
  ], { timeout: timeoutMs });
}

async function frameFiles(outputDir: string) {
  return (await fs.promises.readdir(outputDir)).filter(name => name.startsWith("frame-") && name.endsWith(".jpg"))
    .sort().map(name => path.join(outputDir, name));
}

async function extractFrames(filePath: string, outputDir: string, maxFrames: number, nsfwjs: boolean, timeoutMs: number): Promise<string[]> {
  await fs.promises.mkdir(outputDir);
  const duration = maxFrames > 1 ? await readDuration(filePath, timeoutMs) : 0;
  await writeFrames(filePath, path.join(outputDir, "frame-%02d.jpg"), frameFilters(maxFrames, duration, nsfwjs), maxFrames, nsfwjs, timeoutMs);
  const frames = await frameFiles(outputDir);
  if (frames.length === 0) throw new Error("ffmpeg extracted no frames");
  return frames;
}

async function readDuration(filePath: string, timeoutMs: number): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath],
      { timeout: Math.min(timeoutMs, 10_000) },
    );
    const duration = Number(stdout.trim());
    return Number.isFinite(duration) && duration > 0 ? duration : 0;
  } catch {
    return 0;
  }
}

function validScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validNudityScores(value: unknown): value is NudityScores {
  if (!value || typeof value !== "object") return false;
  const scores = value as Partial<NudityScores>;
  return validScore(scores.nude) && validScore(scores.nipples);
}

function validPrediction(value: unknown): value is Prediction {
  if (!value || typeof value !== "object") return false;
  const prediction = value as Partial<Prediction>;
  return typeof prediction.className === "string" && validScore(prediction.probability);
}
