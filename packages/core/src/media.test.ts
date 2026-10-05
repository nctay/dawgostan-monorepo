import { describe, expect, it } from "vitest";
import { extractUrls, isAnimatedWebp, isPlatformMediaUrl, isSupportedMediaUrl, mediaTypeFromUrl, normalizeUrl } from "./media.js";

describe("media helpers", () => {
  it("extracts common chat URLs", () => {
    expect(extractUrls("look https://cdn.discordapp.com/a/b/c.png, and www.example.com/x")).toEqual([
      "https://cdn.discordapp.com/a/b/c.png",
      "www.example.com/x",
    ]);
  });

  it("detects supported media URLs", () => {
    expect(isSupportedMediaUrl("https://media.discordapp.net/attachments/a/b/file")).toBe(true);
    expect(mediaTypeFromUrl("https://example.com/video.mp4")).toBe("video");
    expect(isSupportedMediaUrl("https://example.com/page")).toBe(false);
  });

  it("detects supported platform video URLs", () => {
    expect(isSupportedMediaUrl("https://www.tiktok.com/@example/video/1234567890")).toBe(true);
    expect(isSupportedMediaUrl("https://vm.tiktok.com/ZMabcdef/")).toBe(true);
    expect(isSupportedMediaUrl("https://www.tiktok.com/@example")).toBe(false);
    expect(isSupportedMediaUrl("https://www.tiktok.com/@example/")).toBe(false);
    expect(isSupportedMediaUrl("https://www.youtube.com/shorts/abc123")).toBe(true);
    expect(isSupportedMediaUrl("https://youtu.be/abc123")).toBe(true);
    expect(isSupportedMediaUrl("https://www.youtube.com/watch?v=1pQ1g5uGj7s")).toBe(true);
    expect(isPlatformMediaUrl("https://www.youtube.com/watch?v=1pQ1g5uGj7s")).toBe(true);
    expect(isSupportedMediaUrl("https://www.youtube.com/watch?list=abc123")).toBe(false);
  });

  it("detects supported Postimages page URLs", () => {
    expect(isSupportedMediaUrl("https://postimg.cc/Z0s0qgxY")).toBe(true);
    expect(isSupportedMediaUrl("https://postimg.cc/2VfXX46j")).toBe(true);
    expect(mediaTypeFromUrl("https://postimg.cc/Z0s0qgxY")).toBe("other");
    expect(isSupportedMediaUrl("https://postimg.cc/gallery/abc")).toBe(false);
    expect(isSupportedMediaUrl("https://ibb.co/BJtPy5F")).toBe(true);
    expect(mediaTypeFromUrl("https://ibb.co/BJtPy5F")).toBe("other");
    expect(isSupportedMediaUrl("https://eblo.id/eLuDq7N")).toBe(true);
    expect(isSupportedMediaUrl("https://eblo.id/@hokusmodertwitcha")).toBe(false);
  });

  it("accepts Yandex Disk public files but not arbitrary Disk pages", () => {
    expect(isSupportedMediaUrl("https://disk.yandex.ru/i/mkcCJXbMfEzTkw")).toBe(true);
    expect(isSupportedMediaUrl("https://disk.yandex.ru/d/abc123")).toBe(true);
    expect(isSupportedMediaUrl("https://yadi.sk/i/mkcCJXbMfEzTkw")).toBe(true);
    expect(normalizeUrl("https://yadi.sk/i/mkcCJXbMfEzTkw/?utm_source=chat")).toBe("https://disk.yandex.ru/i/mkcCJXbMfEzTkw");
    expect(isSupportedMediaUrl("https://disk.yandex.ru/client/disk")).toBe(false);
    expect(isSupportedMediaUrl("https://disk.yandex.ru/client/not-a-public-file.png")).toBe(false);
    expect(isSupportedMediaUrl("https://disk.yandex.ru/i/")).toBe(false);
    expect(isSupportedMediaUrl("https://disk.yandex.ru.evil.com/i/abc123")).toBe(false);
  });

  it("routes Twitch clips to the platform downloader and deduplicates URL variants", () => {
    const slug = "DaintyUninterestedCroquetteYouWHY-qeA25bWxkzdRS1Wf";
    const canonical = `https://clips.twitch.tv/${slug}`;
    for (const url of [canonical, `${canonical}/?tt_content=url&tt_medium=clips_api`,
      `https://www.twitch.tv/ahmad153/clip/${slug}?filter=clips&range=7d`,
      `https://twitch.tv/ahmad153/clip/${slug}`, `https://m.twitch.tv/ahmad153/clip/${slug}#foo`]) {
      expect(isSupportedMediaUrl(url)).toBe(true);
      expect(isPlatformMediaUrl(url)).toBe(true);
      expect(normalizeUrl(url)).toBe(canonical);
    }
    for (const url of ["https://www.twitch.tv/ahmad153", "https://www.twitch.tv/videos/123",
      "https://www.twitch.tv/ahmad153/clips", "https://www.twitch.tv/ahmad153/clip/",
      "https://clips.twitch.tv/", `https://twitch.tv.evil.com/ahmad153/clip/${slug}`]) {
      expect(isSupportedMediaUrl(url)).toBe(false);
      expect(isPlatformMediaUrl(url)).toBe(false);
      expect(normalizeUrl(url)).toBe(url);
    }
  });

  it("detects signed Discord CDN image URLs", () => {
    const url =
      "https://cdn.discordapp.com/attachments/1506760976450584768/1507052247148658852/image.png?ex=6a107f47&is=6a0f2dc7&hm=d010d91051a0ae08e179d86a13eca6e3aa35bd56b97db01cfe7a3c81f24dcd86&";

    expect(extractUrls(url)).toEqual([url]);
    expect(isSupportedMediaUrl(url)).toBe(true);
    expect(mediaTypeFromUrl(url)).toBe("image");
  });

  it("normalizes discord cache-busting query params", () => {
    expect(normalizeUrl("https://cdn.discordapp.com/a.png?ex=1&hm=2&width=800&height=600")).toBe(
      "https://cdn.discordapp.com/a.png?width=800&height=600",
    );
  });

  it("detects animated WebP containers", () => {
    const animated = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x41, 0x4e, 0x49, 0x4d, 0x00, 0x00, 0x00, 0x00,
    ]);
    const still = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, 0x00, 0x00, 0x00, 0x00,
    ]);

    expect(isAnimatedWebp(animated)).toBe(true);
    expect(isAnimatedWebp(still)).toBe(false);
  });
});
