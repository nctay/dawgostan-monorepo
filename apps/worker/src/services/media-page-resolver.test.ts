import { describe, expect, it } from "vitest";
import { extractMediaPageUrls, extractPostimageDirectImageUrl, isResolvableMediaPageUrl } from "./media-page-resolver.js";

describe("media page resolver", () => {
  it("extracts Postimages direct image URLs from og:image", () => {
    const pageUrl = new URL("https://postimg.cc/Z0s0qgxY");
    const html = '<meta property="og:image" content="https://i.postimg.cc/pXRjsM9j/izobrazenie.png">';

    expect(extractPostimageDirectImageUrl(html, pageUrl)?.toString()).toBe("https://i.postimg.cc/pXRjsM9j/izobrazenie.png");
  });

  it("falls back to the direct input and decodes HTML entities", () => {
    const pageUrl = new URL("https://postimg.cc/Z0s0qgxY");
    const html = '<input type="text" id="direct" value="https://i.postimg.cc/pXRjsM9j/izobrazenie.png?x=1&amp;y=2">';

    expect(extractPostimageDirectImageUrl(html, pageUrl)?.toString()).toBe("https://i.postimg.cc/pXRjsM9j/izobrazenie.png?x=1&y=2");
  });

  it("recognizes Postimages pages as resolvable media pages", () => {
    expect(isResolvableMediaPageUrl("https://postimg.cc/Z0s0qgxY")).toBe(true);
    expect(isResolvableMediaPageUrl("https://ibb.co/BJtPy5F")).toBe(true);
    expect(isResolvableMediaPageUrl("https://example.com/Z0s0qgxY")).toBe(false);
  });

  it("extracts the direct image from an ibb.co page", () => {
    const pageUrl = new URL("https://ibb.co/BJtPy5F");
    const html = '<meta property="og:image" content="https://i.ibb.co/GD0JW4N/photo.jpg" />';
    expect(extractPostimageDirectImageUrl(html, pageUrl)?.toString()).toBe("https://i.ibb.co/GD0JW4N/photo.jpg");
  });

  it("extracts the displayed eblo.id image instead of its thumbnail", () => {
    const pageUrl = new URL("https://eblo.id/eLuDq7N");
    const html = '<meta property="og:image" content="/uploads/thumbs/eLuDq7N_thumb.webp"><img id="preview-image" src="/uploads/eLuDq7N/photo.opt.webp">';
    expect(isResolvableMediaPageUrl(pageUrl.toString())).toBe(true);
    expect(extractPostimageDirectImageUrl(html, pageUrl)?.toString()).toBe("https://eblo.id/uploads/eLuDq7N/photo.opt.webp");
    expect(extractPostimageDirectImageUrl('<meta property="og:image" content="/uploads/thumbs/eLuDq7N_thumb.webp">', pageUrl)).toBeNull();
  });

  it("extracts every image from an eblo.id album", () => {
    const pageUrl = new URL("https://eblo.id/ATTkHNV");
    const html = [
      '<img src="/uploads/one/photo.opt.webp" class="album-media">',
      '<img class="album-media active" src="/uploads/two/photo.opt.webp">',
    ].join("");

    expect(extractMediaPageUrls(html, pageUrl).map(String)).toEqual([
      "https://eblo.id/uploads/one/photo.opt.webp",
      "https://eblo.id/uploads/two/photo.opt.webp",
    ]);
  });

  it("extracts an eblo.id video from og:video", () => {
    const pageUrl = new URL("https://eblo.id/x5rEVha");
    const html = '<meta property="og:video" content="/uploads/x5rEVha/1006(1).opt.mp4">';

    expect(extractMediaPageUrls(html, pageUrl).map(String)).toEqual([
      "https://eblo.id/uploads/x5rEVha/1006(1).opt.mp4",
    ]);
  });
});
