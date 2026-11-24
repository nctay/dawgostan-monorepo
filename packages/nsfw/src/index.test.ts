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
        expect(fetchMock).toHaveBeenCalledTimes(1);
        if (animated) {
          fetchMock.mockClear().mockResolvedValue({ ok: true, json: async () => ({ owen: 0.1, siglip: 0.2 }) });
          expect((await classifyNsfw(media, mediaType, animated, config)).publicSpoiler).toBe(false);
          expect(fetchMock).toHaveBeenCalledTimes(8);
          fetchMock.mockResolvedValue({ ok: true, json: async () => ({ owen: 0.81, siglip: 0.2 }) });
        }
      }
    } finally {
      vi.unstubAllGlobals();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { sourceFrames: 1, decoderError: false },
    { sourceFrames: 8, decoderError: false },
    { sourceFrames: 8, decoderError: true },
  ])("handles an unknown-duration WebM with $sourceFrames source frames and decoderError=$decoderError", async ({ sourceFrames, decoderError }) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dawgostan-nsfw-webm-"));
    const file = path.join(directory, "stream.webm");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ owen: 0.1, siglip: 0.2 }) });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { stdout } = await promisify(execFile)("ffmpeg", ["-v", "error", "-f", "lavfi", "-i",
        "testsrc2=size=64x64:rate=8", "-frames:v", String(sourceFrames), "-c:v", "libvpx", "-f", "webm", "pipe:1"], { encoding: "buffer" });
      await fs.writeFile(file, stdout);
      const probe = await promisify(execFile)("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=nb_read_frames:format=duration", "-of", "csv=p=0", file]);
      expect(probe.stdout.trim().split(/\s+/)).toEqual([String(sourceFrames), "N/A"]);
      if (decoderError) {
        fetchMock.mockImplementationOnce(async () => {
          await fs.writeFile(file, "invalid media for the second pass");
          return Response.json({ owen: 0.1, siglip: 0.2 });
        });
      }
      const result = await classifyNsfw(file, "video", false, config);
      expect(result).toEqual(decoderError
        ? { publicSpoiler: true, status: "error" }
        : { publicSpoiler: false, status: "ok", owenScore: 0.1, siglipScore: 0.2 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it.each([1, 2, 8, null])("extracts only the needed GIF batches and checks distinct frames in order when the hit is %s", async hit => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dawgostan-nsfw-gif-"));
    const file = path.join(directory, "animated.gif");
    try {
      await promisify(execFile)("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=96x64:rate=1:duration=8", file]);
      await promisify(execFile)("ffmpeg", ["-v", "error", "-i", file, "-q:v", "1", path.join(directory, "expected-%d.jpg")]);
      const expected = await Promise.all(Array.from({ length: 8 }, (_, i) => fs.readFile(path.join(directory, `expected-${i + 1}.jpg`))));
      const seen: number[] = [];
      const reads = vi.spyOn(fs, "readFile");
      const prepared: number[] = [];
      vi.stubGlobal("fetch", async (_url: string, { body }: { body: Buffer }) => {
        const frame = expected.findIndex(bytes => bytes.equals(body)) + 1;
        seen.push(frame);
        prepared.push((await fs.readdir(path.dirname(String(reads.mock.lastCall![0])))).length);
        return Response.json({ owen: frame === hit ? 0.8 : 0.1, siglip: 0.2 });
      });
      expect(await classifyNsfw(file, "image", true, config)).toEqual({ publicSpoiler: hit !== null, status: "ok", owenScore: hit === null ? 0.1 : 0.8, siglipScore: 0.2 });
      expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8].slice(0, hit ?? 8));
      expect(prepared).toEqual([1, 2, 4, 4, 8, 8, 8, 8].slice(0, hit ?? 8));
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { hit: 1, expected: 1 }, { hit: 5, expected: 5 }, { hit: null, expected: 8 },
  ])("extracts and classifies $expected evenly spaced video frames when the first hit is $hit", async ({ hit, expected }) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dawgostan-nsfw-seek-test-"));
    const video = path.join(directory, "video.mp4");
    const binDir = path.join(directory, "bin");
    await fs.mkdir(binDir);
    await fs.writeFile(video, "fixture");
    await fs.writeFile(path.join(binDir, "ffprobe"), "#!/bin/sh\necho 200\n", { mode: 0o755 });
    // Put the arguments in each fake frame so the classifier receives a record of how it was extracted.
    await fs.writeFile(path.join(binDir, "ffmpeg"), `#!/bin/sh
for arg in "$@"; do output=$arg; done
echo frame >> "$0.calls"
printf '%s\\n' "$@" > "$output"
`, { mode: 0o755 });
    vi.stubEnv("PATH", `${binDir}${path.delimiter}${process.env.PATH}`);
    const commands: string[][] = [];
    vi.stubGlobal("fetch", async (_url: string, { body }: { body: Buffer }) => {
      commands.push(body.toString().trimEnd().split("\n"));
      return { ok: true, json: async () => ({ owen: 0.1, siglip: commands.length === hit ? 0.8 : 0.2 }) };
    });

    try {
      expect(await classifyNsfw(video, "video", false, config)).toEqual({
        publicSpoiler: hit !== null,
        owenScore: 0.1,
        siglipScore: hit !== null ? 0.8 : 0.2,
        status: "ok",
      });
      expect((await fs.readFile(path.join(binDir, "ffmpeg.calls"), "utf8")).trim().split("\n")).toHaveLength(expected);
      expect(commands).toHaveLength(expected);
      for (const [index, args] of commands.entries()) {
        const seek = args.indexOf("-ss");
        const input = args.indexOf("-i");
        expect(seek).toBeGreaterThanOrEqual(0);
        expect(seek).toBeLessThan(input);
        expect(args[seek + 1]).toBe(String(index * 25));
        expect(args[input + 1]).toBe(video);
      }
    } finally {
      vi.unstubAllEnvs();
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
