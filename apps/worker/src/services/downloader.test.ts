import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
  downloadJob: { findUnique: vi.fn(), update: vi.fn() },
  chatPost: { updateMany: vi.fn() },
  asset: { updateMany: vi.fn() },
}));

vi.mock("../env.js", () => ({
  env: { MAX_PARALLEL_DOWNLOADS: 1 },
}));

vi.mock("../prisma.js", () => ({
  prisma: prismaMock,
}));

describe("download failure cleanup", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    prismaMock.$queryRaw.mockResolvedValue([{ id: "job-1" }]);
    prismaMock.downloadJob.findUnique.mockResolvedValue({
      id: "job-1",
      assetId: "asset-1",
      chatPostId: "post-1",
      url: "not-a-url",
      attempts: 3,
      chatPost: {
        normalizedUrl: "https://example.com/media.jpg",
        streamSession: { streamer: {} },
      },
    });
    prismaMock.downloadJob.update.mockResolvedValue({});
    prismaMock.chatPost.updateMany.mockResolvedValue({ count: 2 });
    prismaMock.asset.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.$transaction.mockResolvedValue([]);
  });

  it("fails the asset and every pending post for the same URL after the last attempt", async () => {
    const { processDownloadQueue } = await import("./downloader.js");

    await processDownloadQueue();

    expect(prismaMock.chatPost.updateMany).toHaveBeenCalledWith({
      where: {
        status: "pending",
        OR: [{ id: "post-1" }, { normalizedUrl: "https://example.com/media.jpg" }],
      },
      data: { status: "failed" },
    });
    expect(prismaMock.asset.updateMany).toHaveBeenCalledWith({
      where: { id: "asset-1", status: "pending" },
      data: { status: "failed" },
    });
    expect(prismaMock.$transaction).toHaveBeenCalledOnce();
  });

});
