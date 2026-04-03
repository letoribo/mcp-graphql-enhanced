import {
  buildClientSchema,
  getIntrospectionQuery,
  GraphQLSchema,
  isObjectType,
  isInterfaceType,
  isInputObjectType,
  isEnumType,
  isUnionType,
  isScalarType,
  printSchema,
} from "graphql";
import { readFile } from "node:fs/promises";

/**
 * Introspect a GraphQL endpoint and return the schema as the GraphQL SDL
 */
export async function introspectEndpoint(
  endpoint: string,
  headers?: Record<string, string>,
) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      query: getIntrospectionQuery(),
    }),
  });

  if (!response.ok) {
    throw new Error(`GraphQL request failed: ${response.statusText}`);
  }

  const responseJson = await response.json();
  const schema = buildClientSchema((responseJson as any).data);
  return printSchema(schema);
}

/**
 * Introspect a local GraphQL schema file
 */
export async function introspectLocalSchema(path: string) {
  return await readFile(path, "utf8");
}

/**
 * Extract and filter specific types or root fields from a GraphQL schema.
 * This prevents "No result received" errors by only sending the requested 
 * parts of the graph to the agent, maintaining a stable context window.
 */

export function introspectSpecificTypes(schema: GraphQLSchema, typeNames: string[]) {
  const result: Record<string, any> = {};
  
  // Cache root field maps to avoid repeated lookups during the loop
  const queryType = schema.getQueryType();
  const queryFields = queryType ? queryType.getFields() : {};
  const mutationType = schema.getMutationType();
  const mutationFields = mutationType ? mutationType.getFields() : {};

  for (const name of typeNames) {
    // --- ROOT FIELD RESOLUTION ---
    // Check if the name refers to a root field (Query or Mutation) 
    // rather than a named Type.
    const rootField = queryFields[name] || mutationFields[name];
    
    if (rootField) {
      result[name] = {
        kind: queryFields[name] ? "QUERY_FIELD" : "MUTATION_FIELD",
        description: rootField.description,
        type: rootField.type.toString(),
        args: rootField.args
          .filter(arg => !arg.deprecationReason)
          .map(arg => ({
            name: arg.name,
            type: arg.type.toString(),
            description: arg.description,
          }))
      };
      continue; // Field found, move to next requested name
    }

    // --- NAMED TYPE RESOLUTION ---
    // Fallback to standard type introspection if no root field matches
    const type = schema.getType(name);
    if (!type) continue;

    if (isObjectType(type) || isInterfaceType(type)) {
      result[name] = {
        kind: isInterfaceType(type) ? "INTERFACE" : "OBJECT",
        description: type.description,
        fields: Object.fromEntries(
          Object.entries(type.getFields())
            .filter(([_, field]) => !field.deprecationReason)
            .map(([fieldName, field]) => [
              fieldName,
              {
                type: field.type.toString(),
                description: field.description,
                args: field.args
                  .filter(arg => !arg.deprecationReason)
                  .map(arg => ({
                    name: arg.name,
                    type: arg.type.toString(),
                    description: arg.description,
                  }))
              }
            ])
        )
      };
    } else if (isInputObjectType(type)) {
      result[name] = {
        kind: "INPUT_OBJECT",
        description: type.description,
        fields: Object.fromEntries(
          Object.entries(type.getFields())
            .filter(([_, field]) => !field.deprecationReason)
            .map(([fieldName, field]) => [
              fieldName,
              { type: field.type.toString(), description: field.description }
            ])
        )
      };
    } else if (isEnumType(type)) {
      result[name] = {
        kind: "ENUM",
        description: type.description,
        values: type.getValues().map(v => ({ 
          name: v.name, 
          description: v.description 
        }))
      };
    } else if (isUnionType(type)) {
      result[name] = {
        kind: "UNION",
        description: type.description,
        possibleTypes: type.getTypes().map(t => t.name)
      };
    } else if (isScalarType(type)) {
      result[name] = {
        kind: "SCALAR",
        description: type.description
      };
    }
  }

  return result;
}

/**
 * Backwards compatibility helper for direct endpoint introspection
 */
export async function introspectTypes(
  endpoint: string,
  headers: Record<string, string> = {},
  typeNames: string[]
) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ query: getIntrospectionQuery() }),
  });
  const data = await response.json();
  const schema = buildClientSchema(data.data);

  const result = introspectSpecificTypes(schema, typeNames);
  return JSON.stringify(result);
}