# Production image for the Page Pulse API
FROM node:20-alpine

WORKDIR /app

# Install production dependencies only, using the lockfile for reproducibility.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Run as the built-in non-root user.
USER node

# Basic container healthcheck hitting the liveness endpoint.
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
