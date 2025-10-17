# Use Node.js LTS
FROM node:22-alpine

# Install your package globally
RUN npm install -g @letoribo/mcp-graphql-enhanced@2.1.2

# Run it
ENTRYPOINT ["mcp-graphql-enhanced", "--transport", "stdio"]