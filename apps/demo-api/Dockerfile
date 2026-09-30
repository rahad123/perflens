FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@10.12.4
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/demo-api/package.json apps/demo-api/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY apps/demo-api apps/demo-api
RUN pnpm --filter demo-api build
RUN pnpm --filter demo-api --prod --ignore-scripts deploy --legacy /runtime

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /runtime ./
USER node
EXPOSE 3000
CMD ["node", "--require", "./dist/instrumentation.js", "dist/main.js"]
