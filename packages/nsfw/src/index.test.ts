import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { classifyNsfw, frameFilters, framesToCheck, highestHardNsfwPrediction, shouldSpoiler, shouldSpoilerEnsemble } from "./index.js";

const config = { ensembleClassifierUrl: "http://localhost/classify", ensembleThreshold: 0.8, maxFrames: 8 };

describe("NSFW classification", () => {
  it("uses the configured threshold and samples videos and animations", () => {
    expect(framesToCheck("image", false, 8)).toBe(1);
    expect(framesToCheck("image", true, 8)).toBe(8);
    expect(framesToCheck("video", false, 8)).toBe(8);
    expect(shouldSpoilerEnsemble(0.799, 0.799, 0.8)).toBe(false);
    expect(shouldSpoilerEnsemble(0.8, 0.1, 0.8)).toBe(true);
    expect(shouldSpoilerEnsemble(0.1, 0.8, 0.8)).toBe(true);
  });

  it("classifies extracted frames with both model scores", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dawgostan-nsfw-test-"));
    const image = path.join(directory, "tiny.png");
    await fs.writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAKklEQVR4nO3NQQ0AAAjEMEjwL5lggvt1AtbeyjbhPwAAAAAAAAAAAHjrAA+jAXywnK1EAAAAAElFTkSuQmCC", "base64"));
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ owen: 0.81, siglip: 0.2 }) });
    vi.stubGlobal("fetch", fetchMock);
    try {
      expect(await classifyNsfw(image, "image", false, config)).toEqual({ publicSpoiler: true, owenScore: 0.81, siglipScore: 0.2, status: "ok" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      for (const [extension, mediaType, animated] of [["gif", "image", true], ["mp4", "video", false]] as const) {
        const media = path.join(directory, `tiny.${extension}`);
        await promisify(execFile)("ffmpeg", ["-v", "error", "-loop", "1", "-i", image, "-t", "1", "-vf", "fps=8", ...(extension === "mp4" ? ["-c:v", "mpeg4"] : []), media]);
        fetchMock.mockClear();
        expect(await classifyNsfw(media, mediaType, animated, config)).toEqual({ publicSpoiler: true, owenScore: 0.81, siglipScore: 0.2, status: "ok" });
        expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
      }
    } finally {
      vi.unstubAllGlobals();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("fast-seeks video frames instead of decoding the whole video until timeout", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dawgostan-nsfw-seek-test-"));
    const video = path.join(directory, "video.mp4");
    const binDir = path.join(directory, "bin");
    const previousPath = process.env.PATH;
    await fs.mkdir(binDir);
    await fs.writeFile(video, "fixture");
    await fs.writeFile(path.join(binDir, "ffprobe"), `#!/usr/bin/env node
process.stdout.write("198.56\\n");
`, { mode: 0o755 });
    await fs.writeFile(path.join(binDir, "ffmpeg"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const seek = args.indexOf("-ss");
const input = args.indexOf("-i");
if (seek < 0 || seek > input) {
  setTimeout(() => process.exit(1), 1000);
} else {
  fs.writeFileSync(args.at(-1), "frame");
}
`, { mode: 0o755 });
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ owen: 0.1, siglip: 0.2 }) });
    vi.stubGlobal("fetch", fetchMock);

    try {
      expect(await classifyNsfw(video, "video", false, { ...config, requestTimeoutMs: 500 })).toEqual({
        publicSpoiler: false,
        owenScore: 0.1,
        siglipScore: 0.2,
        status: "ok",
      });
      expect(fetchMock).toHaveBeenCalledTimes(8);
    } finally {
      process.env.PATH = previousPath;
      vi.unstubAllGlobals();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps video frame aspect ratio", () => {
    expect(frameFilters(8, 24, true)).toEqual(["fps=0.3333333333333333", "scale=224:224:force_original_aspect_ratio=decrease"]);
    expect(frameFilters(1, 0, true)).toEqual(["scale=224:224:force_original_aspect_ratio=decrease", "pad=224:224:(ow-iw)/2:(oh-ih)/2"]);
  });

  it("supports legacy detector thresholds and prediction filtering", () => {
    const thresholds = { nudeThreshold: 0.9, nipplesThreshold: 0.9, nsfwjsSpoilerThreshold: 0.9 };
    expect(shouldSpoiler({ nude: 0.9, nipples: 0 }, 0, thresholds)).toBe(true);
    expect(shouldSpoiler({ nude: 0, nipples: 0 }, 0.899, thresholds)).toBe(false);
    expect(highestHardNsfwPrediction([
      { className: "Sexy", probability: 0.99 },
      { className: "Porn", probability: 0.4 },
      { className: "Hentai", probability: 0.713 },
      { className: "Hentai", probability: Number.NaN },
    ])).toEqual({ className: "Hentai", probability: 0.713 });
  });
});
