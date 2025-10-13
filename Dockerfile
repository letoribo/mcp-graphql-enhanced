# Use official Node.js LTS image
FROM node:22-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production && npm cache clean --force

# Copy built code from dist/
COPY dist/ ./dist/

# Make the entrypoint executable
RUN chmod +x dist/index.js

# Run as non-root user (security best practice)
USER node

# MCP tools use stdio — no ports needed
ENTRYPOINT ["node", "dist/index.js"]
