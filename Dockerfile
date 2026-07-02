# Build stage
FROM node:20-slim AS builder

WORKDIR /app

# Install build tools for better-sqlite3 native module
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# Production stage
FROM node:20-slim

WORKDIR /app

# Install build tools for better-sqlite3 native module
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

# Copy built frontend
COPY --from=builder /app/dist ./dist

# Copy server and config files
COPY server.ts ./
COPY tsconfig.json ./
COPY vite.config.ts ./
COPY index.html ./
COPY src ./src

# Data directory (will be mounted as persistent volume)
RUN mkdir -p /data

ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_DIR=/data

EXPOSE 3000

CMD ["npx", "tsx", "server.ts"]
