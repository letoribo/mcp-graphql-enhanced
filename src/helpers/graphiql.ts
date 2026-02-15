/**
 * Renders the GraphiQL IDE template with visible headers
 * @param endpoint The GraphQL API endpoint to connect to
 * @param headers Optional default headers to inject into the editor
 */
export function renderGraphiQL(endpoint: string, headers: object = {}): string {
    // Stringify headers for the injection into the script
    const stringifiedHeaders = JSON.stringify(headers, null, 2);
    
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>GraphiQL Explorer | Surgical MCP</title>
    <link href="https://unpkg.com/graphiql@3.8.2/graphiql.min.css" rel="stylesheet" />
    <style>
        body { 
            margin: 0; 
            height: 100vh; 
            width: 100vw; 
            overflow: hidden; 
            background: #0b1016; 
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }
        #graphiql { height: 100vh; }
        .loading-screen { 
            color: white; 
            display: flex; 
            justify-content: center; 
            align-items: center; 
            height: 100%; 
            font-size: 1.2rem;
        }
    </style>
</head>
<body>
    <div id="graphiql">
        <div class="loading-screen">Initializing Surgical GraphiQL...</div>
    </div>

    <script src="https://unpkg.com/react@18.2.0/umd/react.production.min.js" crossorigin referrerpolicy="no-referrer"></script>
    <script src="https://unpkg.com/react-dom@18.2.0/umd/react-dom.production.min.js" crossorigin referrerpolicy="no-referrer"></script>
    <script src="https://unpkg.com/graphiql@3.8.2/graphiql.min.js" crossorigin referrerpolicy="no-referrer"></script>

    <script>
        window.addEventListener('load', function() {
            if (typeof GraphiQL !== 'undefined') {
                const fetcher = GraphiQL.createFetcher({ 
                    url: '${endpoint}'
                });
                
                const root = ReactDOM.createRoot(document.getElementById('graphiql'));
                root.render(
                    React.createElement(GraphiQL, { 
                        fetcher: fetcher,
                        headerEditorEnabled: true,
                        shouldPersistHeaders: true,
                        // This makes the headers visible in the UI tab
                        defaultHeaders: \`${stringifiedHeaders}\`,
                        theme: 'dark',
                        defaultEditorToolsVisibility: true
                    })
                );
            } else {
                document.getElementById('graphiql').innerHTML = 
                    '<div class="loading-screen" style="color: #ff4d4d">Error: GraphiQL SDK failed to load.</div>';
            }
        });
    </script>
</body>
</html>`;
}