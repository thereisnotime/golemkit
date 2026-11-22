# podman build -t golemkit .
# podman run -d --name golemkit --env-file .env -v ./data:/app/data:Z golemkit fleet fleet.yaml
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
