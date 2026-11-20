# podman build -t mc-buddy .
# podman run -d --name mc-buddy --env-file .env -v ./data:/app/data:Z mc-buddy fleet fleet.yaml
FROM docker.io/library/node:26-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY bots ./bots
COPY scenes ./scenes
USER node
ENTRYPOINT ["node", "src/cli.ts"]
CMD ["run", "buddy"]
