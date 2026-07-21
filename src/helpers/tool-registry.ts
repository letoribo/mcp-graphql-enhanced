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
    handler: (args: any) => Promise<any>,
    outputSchema?: any,
    annotations?: any
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
                    const getZodType = (v: any): any => {
                        let inner = v;
                        let desc: string | undefined = undefined;

                        while (inner?._def) {
                            if (inner._def.description) {
                                desc = inner._def.description;
                            }
                            if (inner._def.innerType) {
                                inner = inner._def.innerType;
                            } else if (inner._def.type) {
                                inner = inner._def.type;
                            } else {
                                break;
                            }
                        }

                        const typeName = inner?._def?.typeName?.replace('Zod', '').toLowerCase() || "string";
                        
                        const result: any = { type: typeName };
                        if (desc) {
                            result.description = desc;
                        }

                        if (typeName === 'array' && inner._def.type) {
                            result.items = getZodType(inner._def.type);
                        }
                        
                        return result;
                    };

                    const typeInfo = getZodType(value);
                    return [key, typeInfo];
                })
            ),
            required: Object.keys(schema).filter(key => {
                const val = schema[key] as any;
                const isOptional = val?._def?.typeName === 'ZodOptional';
                const isDefault = val?._def?.typeName === 'ZodDefault';
                return !isOptional && !isDefault && !key.includes('?');
            })
        },
        ...(outputSchema ? { outputSchema } : {}),
        ...(annotations ? { annotations } : {})
    });
}