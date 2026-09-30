import crypto from "node:crypto";
import { extractUrls, isSupportedMediaUrl, normalizeUrl } from "@dawgostan/core";
import { env } from "../env.js";
import { prisma } from "../prisma.js";
import { isIgnoredChatAuthor, isIgnoredChatCommand } from "../services/chat-filter.js";

const TWITCH_WEB_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const PAGE_SIZE = 100;
const PAGE_STEP_SECONDS = Number(process.env.RECOVERY_PAGE_STEP_SECONDS ?? 30);
const QUERY = `query VideoCommentsByOffsetOrCursor($videoID: ID!, $contentOffsetSeconds: Int) {
  video(id: $videoID) {
    id
    owner { id login displayName }
    createdAt
    title
    comments(first: ${PAGE_SIZE}, contentOffsetSeconds: $contentOffsetSeconds) {
      edges {
        cursor
        node {
          id
          contentOffsetSeconds
          createdAt
          commenter { id login displayName }
          message { fragments { text } }
        }
      }
      pageInfo { hasNextPage }
    }
  }
}`;

type TwitchComment = {
  id: string;
  contentOffsetSeconds: number;
  createdAt: string;
  commenter?: { id?: string; login?: string; displayName?: string } | null;
  message?: { fragments?: Array<{ text?: string | null }> | null } | null;
};

type TwitchVideo = {
  id: string;
  owner: { id: string; login: string; displayName: string };
  createdAt: string;
  title?: string | null;
  comments: {
    edges: Array<{ cursor: string; node: TwitchComment }>;
    pageInfo: { hasNextPage: boolean };
  };
};

type Stats = {
  comments: number;
  mediaUrls: number;
  ignoredAuthor: number;
  ignoredCommand: number;
  existingPosts: number;
  blocked: number;
  reused: number;
  duplicatePending: number;
  queued: number;
};

const stats: Stats = {
  comments: 0,
  mediaUrls: 0,
  ignoredAuthor: 0,
  ignoredCommand: 0,
  existingPosts: 0,
  blocked: 0,
  reused: 0,
  duplicatePending: 0,
  queued: 0,
};
const seenCommentIds = new Set<string>();
const seenMediaKeys = new Set<string>();

const videoId = requiredEnv("RECOVERY_VOD_ID", process.env.RECOVERY_VOD_ID ?? process.env.VOD_ID);
const from = parseDateEnv("RECOVERY_FROM", process.env.RECOVERY_FROM);
const to = parseDateEnv("RECOVERY_TO", process.env.RECOVERY_TO);
const dryRun = process.env.RECOVERY_DRY_RUN !== "false";

if (to <= from) throw new Error("RECOVERY_TO must be after RECOVERY_FROM");

try {
  await main();
} finally {
  await prisma.$disconnect();
}

async function main(): Promise<void> {
  const firstPage = await fetchCommentsPage({ videoId, contentOffsetSeconds: 0 });
  const videoCreatedAt = new Date(firstPage.createdAt);
  const startOffset = Math.max(0, Math.floor((from.getTime() - videoCreatedAt.getTime()) / 1000) - 120);
  const endOffset = Math.floor((to.getTime() - videoCreatedAt.getTime()) / 1000) + 120;

  const page = await fetchCommentsPage({ videoId, contentOffsetSeconds: startOffset });
  const video = { ...page, comments: page.comments };
  const streamerLogin = video.owner.login.toLowerCase();
  const streamer = await prisma.streamer.upsert({
    where: { login: streamerLogin },
    create: {
      twitchUserId: video.owner.id,
      login: streamerLogin,
      displayName: video.owner.displayName,
      lastStatus: "unknown",
      lastCheckedAt: new Date(),
    },
    update: {
      twitchUserId: video.owner.id,
      displayName: video.owner.displayName,
    },
  });
  const session = await findOrCreateSession(streamer.id, video.title ?? null, videoCreatedAt);

  console.log(
    `[recovery] vod=${videoId} streamer=${streamerLogin} window=${from.toISOString()}..${to.toISOString()} offsets=${startOffset}..${endOffset} step=${PAGE_STEP_SECONDS} dryRun=${dryRun}`,
  );

  if (PAGE_STEP_SECONDS <= 0) throw new Error("RECOVERY_PAGE_STEP_SECONDS must be positive");

  await processPage(video, session.id);
  for (let offset = startOffset + PAGE_STEP_SECONDS; offset <= endOffset; offset += PAGE_STEP_SECONDS) {
    const next = await fetchCommentsPage({ videoId, contentOffsetSeconds: offset });
    await processPage(next, session.id);
  }

  console.log(`[recovery] done ${JSON.stringify(stats)}`);
}

async function findOrCreateSession(streamerId: string, title: string | null, videoCreatedAt: Date) {
  const existing = await prisma.streamSession.findFirst({
    where: {
      streamerId,
      startedAt: { lte: from },
      OR: [{ endedAt: null }, { endedAt: { gte: from } }, { startedAt: { gte: new Date(videoCreatedAt.getTime() - 60 * 60 * 1000) } }],
    },
    orderBy: { startedAt: "desc" },
  });
  if (existing) return existing;

  return prisma.streamSession.create({
    data: {
      streamerId,
      title,
      startedAt: videoCreatedAt,
      endedAt: to,
      status: "ended",
    },
  });
}

async function processPage(video: TwitchVideo, sessionId: string): Promise<void> {
  for (const edge of video.comments.edges) {
    const comment = edge.node;
    const postedAt = new Date(comment.createdAt);
    if (postedAt < from || postedAt > to) continue;
    if (seenCommentIds.has(comment.id)) continue;
    seenCommentIds.add(comment.id);
    stats.comments += 1;

    const authorName = comment.commenter?.displayName ?? comment.commenter?.login ?? "unknown";
    const messageText = comment.message?.fragments?.map((fragment) => fragment.text ?? "").join("") ?? "";
    if (isIgnoredChatAuthor(authorName)) {
      stats.ignoredAuthor += 1;
      continue;
    }
    if (isIgnoredChatCommand(messageText)) {
      stats.ignoredCommand += 1;
      continue;
    }

    const urls = extractUrls(messageText).filter(isSupportedMediaUrl);
    for (const rawUrl of urls) {
      const normalizedUrl = normalizeUrl(rawUrl);
      if (!normalizedUrl) continue;
      const mediaKey = `${comment.id}:${normalizedUrl}`;
      if (seenMediaKeys.has(mediaKey)) continue;
      seenMediaKeys.add(mediaKey);
      stats.mediaUrls += 1;
      await recoverMediaUrl({
        sessionId,
        comment,
        authorName,
        messageText,
        rawUrl,
        normalizedUrl,
        postedAt,
      });
    }
  }
}

async function recoverMediaUrl(input: {
  sessionId: string;
  comment: TwitchComment;
  authorName: string;
  messageText: string;
  rawUrl: string;
  normalizedUrl: string;
  postedAt: Date;
}): Promise<void> {
  const twitchMessageId = `vod:${videoId}:${input.comment.id}:${hash(input.normalizedUrl)}`;
  const existingPost = await prisma.chatPost.findUnique({ where: { twitchMessageId } });
  if (existingPost) {
    stats.existingPosts += 1;
    return;
  }

  const blocked = await prisma.blockedMedia.findUnique({ where: { normalizedUrl: input.normalizedUrl } });
  if (blocked) {
    stats.blocked += 1;
    if (!dryRun) {
      await prisma.chatPost.create({
        data: chatPostData(input, twitchMessageId, { status: "blocked" }),
      });
    }
    return;
  }

  const existingAsset = await prisma.asset.findUnique({ where: { normalizedUrl: input.normalizedUrl } });
  const reusableAsset = existingAsset?.status === "stored" ? existingAsset : await findStoredAssetForNormalizedUrl(input.normalizedUrl);
  if (reusableAsset) {
    stats.reused += 1;
    if (!dryRun) {
      await prisma.chatPost.create({
        data: chatPostData(input, twitchMessageId, { assetId: reusableAsset.id, status: "stored" }),
      });
    }
    return;
  }

  const activeJob = existingAsset
    ? await prisma.downloadJob.findFirst({
        where: {
          assetId: existingAsset.id,
          status: { in: ["pending", "running"] },
        },
      })
    : null;
  if (activeJob) stats.duplicatePending += 1;
  else stats.queued += 1;

  if (dryRun) return;

  const post = await prisma.chatPost.create({
    data: chatPostData(input, twitchMessageId, {
      assetId: existingAsset?.id,
      status: "pending",
    }),
  });
  const asset =
    existingAsset ??
    (await prisma.asset.upsert({
      where: { normalizedUrl: input.normalizedUrl },
      update: {},
      create: {
        originalUrl: input.rawUrl,
        normalizedUrl: input.normalizedUrl,
        mediaType: "other",
        status: "pending",
      },
    }));

  if (activeJob) {
    await prisma.chatPost.update({ where: { id: post.id }, data: { assetId: asset.id } });
    return;
  }

  await prisma.downloadJob.create({
    data: {
      assetId: asset.id,
      chatPostId: post.id,
      url: input.rawUrl,
      status: "pending",
    },
  });
  console.log(`[recovery] queued chatPost=${post.id} asset=${asset.id} url=${input.rawUrl}`);
}

function chatPostData(
  input: {
    sessionId: string;
    comment: TwitchComment;
    authorName: string;
    messageText: string;
    rawUrl: string;
    normalizedUrl: string;
    postedAt: Date;
  },
  twitchMessageId: string,
  extra: { assetId?: string; status: "pending" | "stored" | "blocked" },
) {
  const rawTwitchMessageId = `vod:${videoId}:${input.comment.id}`;
  return {
    streamSessionId: input.sessionId,
    twitchMessageId,
    rawTwitchMessageId,
    authorTwitchId: input.comment.commenter?.id,
    authorName: input.authorName,
    messageText: input.messageText,
    originalUrl: input.rawUrl,
    normalizedUrl: input.normalizedUrl,
    postedAt: input.postedAt,
    assetId: extra.assetId,
    status: extra.status,
  };
}

async function findStoredAssetForNormalizedUrl(normalizedUrl: string) {
  const post = await prisma.chatPost.findFirst({
    where: {
      normalizedUrl,
      status: "stored",
      asset: { status: "stored" },
    },
    orderBy: { postedAt: "asc" },
    include: { asset: true },
  });
  return post?.asset ?? null;
}

async function fetchCommentsPage(input: { videoId: string; contentOffsetSeconds: number }): Promise<TwitchVideo> {
  const response = await fetch("https://gql.twitch.tv/gql", {
    method: "POST",
    headers: {
      "Client-ID": TWITCH_WEB_CLIENT_ID,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([
      {
        operationName: "VideoCommentsByOffsetOrCursor",
        variables: {
          videoID: input.videoId,
          contentOffsetSeconds: input.contentOffsetSeconds,
        },
        query: QUERY,
      },
    ]),
  });
  if (!response.ok) throw new Error(`Twitch GQL failed: ${response.status} ${await response.text()}`);
  const body = (await response.json()) as Array<{ data?: { video?: TwitchVideo | null }; errors?: Array<{ message: string }> }>;
  const result = body[0];
  if (result?.errors?.length) throw new Error(`Twitch GQL errors: ${result.errors.map((error) => error.message).join("; ")}`);
  if (!result?.data?.video) throw new Error(`Twitch video not found: ${input.videoId}`);
  return result.data.video;
}

function requiredEnv(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseDateEnv(name: string, value: string | undefined): Date {
  if (!value) throw new Error(`${name} is required, example: 2026-06-09T18:57:00+03:00`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${name} is not a valid date: ${value}`);
  return date;
}

function hash(value: string): string {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 16);
}
