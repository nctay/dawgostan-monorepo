import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSupportedMediaUrl } from "./redirect-resolver.js";

const lookup = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", () => ({ default: { lookup } }));
vi.mock("../env.js", () => ({ env: { ALLOW_PRIVATE_MEDIA_HOSTS: false } }));

afterEach(() => {
  lookup.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("short-link media destinations", () => {
  const short = "https://bit.ly/fixture";
  const target = "https://media.example.com/first.jpg";

  it("returns the safe media Location while the file server is unavailable", async () => {
    lookup.mockResolvedValue([{ address: "93.184.216.34" }]);
    const fetch = vi.fn(async (url: URL) => url.href === short ? Response.redirect(target) : new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetch);

    expect(await resolveSupportedMediaUrl(short)).toBe(target);
    expect(lookup).toHaveBeenCalledWith("media.example.com", { all: true, verbatim: true });
    expect(fetch.mock.calls.map(([url]) => url.href)).toEqual([short, target]);
  });

  it("checks the destination address before returning a media Location", async () => {
    lookup.mockImplementation(async (host: string) => [{ address: host === "bit.ly" ? "93.184.216.34" : "127.0.0.1" }]);
    const fetch = vi.fn(async () => Response.redirect(target));
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await resolveSupportedMediaUrl(short)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("cancels the response body after inspecting the file headers", async () => {
    lookup.mockResolvedValue([{ address: "93.184.216.34" }]);
    const cancel = vi.fn();
    const file = new ReadableStream({ cancel });
    const network = vi.fn(async (url: URL, _init: RequestInit) => url.href === short ? Response.redirect(target) : new Response(file));
    vi.stubGlobal("fetch", network);

    expect(await resolveSupportedMediaUrl(short)).toBe(target);
    expect(new Headers(network.mock.calls[1]![1].headers).get("range")).toBe("bytes=0-0");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    ["video/mp4", true],
    ["video/quicktime", true],
    ["image/svg+xml", false],
    ["video/unknown", false],
    ["application/octet-stream", false],
  ] as const)("classifies an extensionless %s by its headers without parsing binary data", async (mime, accepted) => {
    lookup.mockResolvedValue([{ address: "93.184.216.34" }]);
    const cdn = "https://cdn.example/download?id=fixture";
    const readBinaryAsText = vi.spyOn(Response.prototype, "text");
    vi.stubGlobal("fetch", async (url: URL, init: RequestInit) => {
      if (url.href === short) return Response.redirect(target);
      if (url.href === target) return Response.redirect(cdn);
      return new Response(init.method === "HEAD" ? null : new Uint8Array([1]), { headers: { "content-type": mime } });
    });
    expect(await resolveSupportedMediaUrl(short)).toBe(accepted ? cdn : null);
    expect(readBinaryAsText).not.toHaveBeenCalled();
  });

  it("stops waiting for DNS on shutdown and ignores a late address", async () => {
    const controller = new AbortController();
    let returnAddresses!: (addresses: { address: string }[]) => void;
    lookup.mockImplementation(() => new Promise(resolve => { returnAddresses = resolve; }));
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const result = resolveSupportedMediaUrl(short, controller.signal);
    controller.abort();
    await expect(result).rejects.toBe(controller.signal.reason);
    returnAddresses([{ address: "93.184.216.34" }]);
    await expect(resolveSupportedMediaUrl(short, controller.signal)).rejects.toBe(controller.signal.reason);
    expect(fetch).not.toHaveBeenCalled();
    expect(lookup).toHaveBeenCalledOnce();
  });

  it("passes cancellation to the active HTTP request and starts no further hop", async () => {
    const controller = new AbortController();
    lookup.mockResolvedValue([{ address: "93.184.216.34" }]);
    const fetch = vi.fn(async (_url: URL, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      controller.abort();
    }));
    vi.stubGlobal("fetch", fetch);
    const request = resolveSupportedMediaUrl(short, controller.signal);
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(lookup).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

});
