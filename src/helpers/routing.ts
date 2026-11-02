import { GraphQLSchema, DocumentNode, SelectionSetNode } from "graphql";

function unwrapType(type: any): any {
    let t = type;
    while (t && t.ofType) {
        t = t.ofType;
    }
    return t;
}

/**
 * Universally prunes any GraphQL AST to match a specific node's schema.
 */
export function pruneASTForSchema(parsedQuery: DocumentNode, schema: GraphQLSchema): DocumentNode {
    const queryType = schema.getQueryType();
    const mutationType = schema.getMutationType();
    const subscriptionType = schema.getSubscriptionType();

    const newDefinitions = parsedQuery.definitions.map((def: any) => {
        if (def.kind !== 'OperationDefinition') return def;

        let rootType: any = null;
        if (def.operation === 'query') rootType = queryType;
        else if (def.operation === 'mutation') rootType = mutationType;
        else if (def.operation === 'subscription') rootType = subscriptionType;

        if (!rootType) return def;

        const prunedSelectionSet = pruneSelectionSet(def.selectionSet, rootType, schema);
        return {
            ...def,
            selectionSet: prunedSelectionSet
        };
    });

    return {
        ...parsedQuery,
        definitions: newDefinitions
    };
}

function pruneSelectionSet(
    selectionSet: SelectionSetNode | undefined, 
    parentType: any, 
    schema: GraphQLSchema
): SelectionSetNode | undefined {
    if (!selectionSet || !selectionSet.selections) return selectionSet;

    const unwrappedParent = unwrapType(parentType);
    const fieldsMap = unwrappedParent && typeof unwrappedParent.getFields === 'function' 
        ? unwrappedParent.getFields() 
        : null;

    const newSelections: any[] = [];

    for (const selection of selectionSet.selections) {
        if (selection.kind === 'Field') {
            const fieldName = selection.name.value;
            
            // Always pass through introspection fields
            if (fieldName.startsWith('__')) {
                newSelections.push(selection);
                continue;
            }

            // If field does not exist in this node's schema, drop it completely
            if (!fieldsMap || !fieldsMap[fieldName]) {
                continue;
            }

            const fieldDef = fieldsMap[fieldName];
            const fieldReturnType = fieldDef.type;

            // Recursively prune sub-selections if they exist
            const prunedSubSelections = selection.selectionSet 
                ? pruneSelectionSet(selection.selectionSet, fieldReturnType, schema) 
                : undefined;

            const unwrappedReturnType = unwrapType(fieldReturnType);
            const isObjectType = unwrappedReturnType && typeof unwrappedReturnType.getFields === 'function';

            // If it's an object type field but all its children were pruned, drop the parent field as well
            if (selection.selectionSet && isObjectType && (!prunedSubSelections || prunedSubSelections.selections.length === 0)) {
                continue;
            }

            newSelections.push({
                ...selection,
                selectionSet: prunedSubSelections
            });
        } else if (selection.kind === 'InlineFragment') {
            let fragmentType = parentType;
            if (selection.typeCondition) {
                const typeName = selection.typeCondition.name.value;
                fragmentType = schema.getType(typeName) || parentType;
            }
            const prunedFragSelections = pruneSelectionSet(selection.selectionSet, fragmentType, schema);
            if (prunedFragSelections && prunedFragSelections.selections.length > 0) {
                newSelections.push({
                    ...selection,
                    selectionSet: prunedFragSelections
                });
            }
        } else {
            newSelections.push(selection);
        }
    }

    if (newSelections.length === 0) {
        return undefined;
    }

    return {
        ...selectionSet,
        selections: newSelections
    };
}

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