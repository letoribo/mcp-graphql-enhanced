import { buildSchema } from 'graphql';

export const safeDefaultSchema = buildSchema(`
  type Query {
    tipsAndTricks: [String]
    status: String
  }
`);

export const safeDefaultRoot = {
  tipsAndTricks: [
    "1. Pass a valid ENDPOINT environment variable to connect your custom GraphQL/Neo4j backend.",
    "2. This safe fallback schema is active because no external endpoint was provided.",
    "3. Multi-endpoint broadcast configuration is supported via package settings."
  ],
  status: "Running in secure offline default mode."
};