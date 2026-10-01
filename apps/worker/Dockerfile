FROM node:24-alpine AS base
WORKDIR /app
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/bot/package.json apps/bot/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/media-processing/package.json packages/media-processing/package.json
COPY packages/nsfw/package.json packages/nsfw/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY prisma prisma
COPY packages packages
COPY apps/worker apps/worker
RUN pnpm db:generate
RUN pnpm --filter @dawgostan/core --filter @dawgostan/media-processing --filter @dawgostan/nsfw build
RUN pnpm --filter worker build

FROM base AS runtime
ENV NODE_ENV=production
RUN apk add --no-cache ffmpeg imagemagick python3 py3-pip \
    && python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir 'yt-dlp[default]==2026.8.30.232658.dev0'
ENV PATH="/opt/yt-dlp/bin:${PATH}"
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=build /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/media-processing/package.json ./packages/media-processing/package.json
COPY --from=build /app/packages/media-processing/dist ./packages/media-processing/dist
COPY --from=build /app/packages/nsfw/package.json ./packages/nsfw/package.json
COPY --from=build /app/packages/nsfw/dist ./packages/nsfw/dist
CMD ["node", "apps/worker/dist/worker.js"]
