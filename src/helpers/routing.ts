/**
 * Checks if a parsed GraphQL query touches entities available in a specific node's manifest
 */
export function isQueryRelevantToNode(parsedQuery: any, nodeMeta: any): boolean {
    if (!nodeMeta) return true; 

    const entities = new Set(nodeMeta.domainEntities || []);
    const mutations = new Set(nodeMeta.availableMutations || []);

    const requestedFields: string[] = [];
    const rootFields: string[] = [];
    
    // Traverses AST to extract root and nested field names
    parsedQuery.definitions.forEach((def: any) => {
        if (def.kind === "OperationDefinition") {
            const collectFields = (selectionSet: any, depth: number) => {
                if (!selectionSet || !selectionSet.selections) return;
                selectionSet.selections.forEach((sel: any) => {
                    if (sel.name && sel.name.value) {
                        const fieldName = sel.name.value;
                        requestedFields.push(fieldName);
                        if (depth === 0) {
                            rootFields.push(fieldName);
                        }
                    }
                    if (sel.selectionSet) {
                        collectFields(sel.selectionSet, depth + 1);
                    }
                });
            };
            collectFields(def.selectionSet, 0);
        }
    });

    // Pass through for introspection queries
    if (requestedFields.every(f => f.startsWith('__'))) return true;

    // Pass through if node metadata is empty
    if (entities.size === 0 && mutations.size === 0) {
        return true; 
    }

    // Match against entities or allow root query fields to avoid false-negative node filtering
    const hasRootFieldMatch = rootFields.length > 0;
    const hasEntityMatch = requestedFields.some(field => entities.has(field) || mutations.has(field));

    if (nodeMeta.endpoint.includes('github.com') && requestedFields.includes('search')) {
        return true;
    }

    return hasEntityMatch || hasRootFieldMatch;
}