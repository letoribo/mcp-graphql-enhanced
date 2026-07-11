// src/helpers/tool-registry.ts

/**
 * Universal tool wrapper that registers tools for both MCP and HTTP Discovery.
 * Handles Zod schema parsing to generate metadata for external clients.
 */
export function registerTool(
    server: any,
    toolHandlers: Map<string, (args: any) => Promise<any>>,
    registeredToolsMetadata: any[],
    name: string,
    description: string,
    schema: any,
    handler: (args: any) => Promise<any>
) {
    // 1. Official MCP Server registration
    server.tool(name, description, schema, handler);

    // 2. Map handler for internal HTTP routing
    toolHandlers.set(name, handler);

    // 3. Smart metadata generation for Discovery (HTTP list-tools)
    registeredToolsMetadata.push({
        name,
        description,
        inputSchema: {
            type: "object",
            properties: Object.fromEntries(
                Object.entries(schema).map(([key, value]: [string, any]) => {
                    // Recursive helper to extract type info from Zod objects
                    const getZodType = (v: any): any => {
                        const type = v?._def?.typeName?.replace('Zod', '').toLowerCase() || "string";
                        
                        if (type === 'array') {
                            return {
                                type: "array",
                                items: { type: getZodType(v._def.type) }
                            };
                        }
                        return { type };
                    };

                    const typeInfo = getZodType(value);
                    return [key, typeInfo];
                })
            ),
            // Identify required fields by checking for ZodOptional or '?' in key
            required: Object.keys(schema).filter(key => {
                const val = schema[key] as any;
                const isOptional = val?._def?.typeName === 'ZodOptional';
                const isDefault = val?._def?.typeName === 'ZodDefault';
                return !isOptional && !isDefault && !key.includes('?');
            })
        }
    });
}