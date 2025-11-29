FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production=false

COPY . .
RUN npx prisma generate
RUN npm run build

EXPOSE 4000

# Run migrations on container startup, then start server
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
