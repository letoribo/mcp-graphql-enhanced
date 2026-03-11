// src/helpers/prompt-registry.ts

/**
 * Universal prompt wrapper for MCP server
 */
export function registerPrompt(
    server: any, 
    name: string, 
    description: string, 
    template: string
) {
    server.prompt(name, description, (args: any) => {
        return {
            messages: [
                {
                    role: "user",
                    content: {
                        type: "text",
                        text: template + (args?.focus ? ` Focus on: ${args.focus}` : "")
                    }
                }
            ]
        };
    });
}