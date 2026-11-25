# podman build -t golemkit .        (or: just image)
# podman run -d --name golemkit --env-file .env -v ./data:/app/data:Z golemkit run buddy
# A private fleet file (fleet.yaml is gitignored and not in the image) is mounted in:
# podman run -d --name golemkit --env-file .env -v ./data:/app/data:Z -v ./fleet.yaml:/app/fleet.yaml:ro,Z golemkit fleet fleet.yaml
FROM docker.io/library/node:26-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY variants ./variants
COPY profiles ./profiles
COPY fleets ./fleets
COPY blueprints ./blueprints
COPY scenes ./scenes
# Writable state: bot data, LLM logins, log files, the compile cache.
RUN mkdir -p data .auth logs .cache && chown node:node data .auth logs .cache
# Type-stripped source cached between starts (docs/guide/deployment.md#memory)
ENV NODE_COMPILE_CACHE=/app/.cache/node-compile
USER node
ENTRYPOINT ["node", "--max-semi-space-size=8", "src/cli.ts"]
CMD ["run", "buddy"]
