FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production=false

COPY . .
RUN npx prisma generate
RUN npm run build

EXPOSE 4000

CMD ["npm", "run", "start"]
