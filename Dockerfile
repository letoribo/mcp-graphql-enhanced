# Dockerfile
FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

COPY dist/ ./dist/

RUN chmod +x dist/index.js

USER node

ENTRYPOINT ["node", "dist/index.js"]