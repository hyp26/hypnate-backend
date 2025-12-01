FROM node:20-slim

# Install OpenSSL (needed by Prisma engines)
RUN apt-get update && \
    apt-get install -y openssl ca-certificates && \
    update-ca-certificates && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --production=false

COPY . .

# Generate Prisma Client
RUN npx prisma generate

# Build TypeScript
RUN npm run build

EXPOSE 4000

# Run migrations on container startup, then start server
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
