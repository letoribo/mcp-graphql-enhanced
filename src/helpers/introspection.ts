import {
  buildClientSchema,
  getIntrospectionQuery,
  GraphQLObjectType,
  GraphQLInterfaceType,
  GraphQLUnionType,
  GraphQLEnumType,
  GraphQLScalarType,
  GraphQLInputObjectType,
  GraphQLNamedType,
  printSchema,
} from "graphql";
import { readFile } from "node:fs/promises";

/**
 * Introspect a GraphQL endpoint and return the schema as the GraphQL SDL
 * @param endpoint - The endpoint to introspect
 * @param headers - Optional headers to include in the request
 * @returns The schema
 */
export async function introspectEndpoint(
	endpoint: string,
	headers?: Record<string, string>,
) {
	const response = await fetch(endpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...headers,
		},
		body: JSON.stringify({
			query: getIntrospectionQuery(),
		}),
	});

	if (!response.ok) {
		throw new Error(`GraphQL request failed: ${response.statusText}`);
	}

	const responseJson = await response.json();
	// Transform to a schema object
	const schema = buildClientSchema((responseJson as any).data);

	// Print the schema SDL
	return printSchema(schema);
}

/**
 * Introspect a GraphQL schema file hosted at a URL and return the schema as the GraphQL SDL
 * @param url - The URL to the schema file
 * @returns The schema
 */
export async function introspectSchemaFromUrl(url: string) {
	const response = await fetch(url);

	if (!response.ok) {
		throw new Error(`Failed to fetch schema from URL: ${response.statusText}`);
	}

	const schema = await response.text();
	return schema;
}

/**
 * Introspect a local GraphQL schema file and return the schema as the GraphQL SDL
 * @param path - The path to the local schema file
 * @returns The schema
 */
export async function introspectLocalSchema(path: string) {
	const schema = await readFile(path, "utf8");
	return schema;
}

function isObjectLikeType(type: GraphQLNamedType): type is GraphQLObjectType | GraphQLInterfaceType {
  return 'getFields' in type;
}

function isUnionType(type: GraphQLNamedType): type is GraphQLUnionType {
  return 'getTypes' in type;
}

function isEnumType(type: GraphQLNamedType): type is GraphQLEnumType {
  return 'getValues' in type;
}

function isInputObjectType(type: GraphQLNamedType): type is GraphQLInputObjectType {
  return 'getFields' in type;
}

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

  const result: Record<string, any> = {};
  for (const name of typeNames) {
    const type = schema.getType(name);
    if (!type) continue;

    // Handle object/interface types
    if (isObjectLikeType(type)) {
      result[name] = {
        kind: type instanceof GraphQLObjectType ? "OBJECT" : "INTERFACE",
        description: type.description,
        fields: Object.fromEntries(
          Object.entries(type.getFields()).map(([fieldName, field]) => [
            fieldName,
            {
              type: field.type.toString(),
              description: field.description,
              args: field.args.map(arg => ({
                name: arg.name,
                type: arg.type.toString(),
                description: arg.description,
              }))
            }
          ])
        )
      };
    }
    // Handle union types
    else if (isUnionType(type)) {
      result[name] = {
        kind: "UNION",
        description: type.description,
        possibleTypes: type.getTypes().map(t => t.name)
      };
    }
    // Handle enums
    else if (isEnumType(type)) {
      result[name] = {
        kind: "ENUM",
        description: type.description,
        values: type.getValues().map(v => ({
          name: v.name,
          description: v.description
        }))
      };
    }
    // Handle scalars and input objects
    else if (isInputObjectType(type)) {
      result[name] = {
        kind: "INPUT_OBJECT",
        description: type.description,
        fields: Object.fromEntries(
          Object.entries(type.getFields()).map(([fieldName, field]) => [
            fieldName,
            { type: field.type.toString(), description: field.description }
          ])
        )
      };
    }
    else if (type instanceof GraphQLScalarType) {
      result[name] = {
        kind: "SCALAR",
        description: type.description
      };
    }
  }

  return JSON.stringify(result, null, 2);
}
