/**
 * Checks if a parsed GraphQL query touches entities available in a specific node's manifest
 */
export function isQueryRelevantToNode(parsedQuery: any, nodeMeta: any): boolean {
    if (!nodeMeta) return true; 

    const entities = new Set(nodeMeta.domainEntities || []);
    const mutations = new Set(nodeMeta.availableMutations || []);

    const requestedFields: string[] = [];
    
    parsedQuery.definitions.forEach((def: any) => {
        if (def.kind === "OperationDefinition") {
            const collectFields = (selectionSet: any) => {
                if (!selectionSet || !selectionSet.selections) return;
                selectionSet.selections.forEach((sel: any) => {
                    if (sel.name && sel.name.value) {
                        requestedFields.push(sel.name.value);
                    }
                    if (sel.selectionSet) {
                        collectFields(sel.selectionSet);
                    }
                });
            };
            collectFields(def.selectionSet);
        }
    });

    if (requestedFields.every(f => f.startsWith('__'))) return true;

    if (entities.size === 0 && mutations.size === 0) {
        return true; 
    }

    const hasEntityMatch = requestedFields.some(field => entities.has(field) || mutations.has(field));

    if (nodeMeta.endpoint.includes('github.com') && requestedFields.includes('search')) {
        return true;
    }

    return hasEntityMatch;
}