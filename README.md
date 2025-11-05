# MongoDB MCP Server

A Model Context Protocol (MCP) server that provides MongoDB database access through mongosh commands, with flexible connection management and comprehensive query capabilities.

## Features

- 🔌 **Flexible Connection Management**: Support for multiple MongoDB environments
- 🔒 **Secure Configuration**: Environment variable substitution for credentials
- 🚀 **Full mongosh Support**: Execute any MongoDB command or query
- 📊 **Native MongoDB Syntax**: Use familiar MongoDB shell commands directly
- 📚 **Documentation Integration**: Context-aware assistance with collection schemas
- 🛡️ **Error Handling**: Comprehensive error reporting and recovery

## Quick Start

### 1. Installation

```bash
npm install @your-org/mongo-mcp-server
```

### 2. Configuration

Create a configuration file in one of these locations:
- `./mongo-connections.json` (current directory)
- `~/.mongo-mcp/connections.json` (user home)
- Custom path via `MONGO_MCP_CONFIG` environment variable

**Example configuration:**

```json
{
  "connections": {
    "local": {
      "name": "Local Development",
      "host": "localhost",
      "port": 27017,
      "database": "myapp",
      "options": {
        "retryWrites": true
      }
    },
    "production": {
      "name": "Production",
      "host": "${MONGO_PROD_HOST}",
      "port": "${MONGO_PROD_PORT}",
      "database": "${MONGO_PROD_DATABASE}",
      "username": "${MONGO_PROD_USER}",
      "password": "${MONGO_PROD_PASS}",
      "authSource": "admin",
      "options": {
        "readPreference": "secondaryPreferred"
      }
    }
  }
}
```

### 3. Environment Variables

Create a `.env` file for sensitive credentials:

```bash
MONGO_PROD_HOST=localhost
MONGO_PROD_PORT=27020
MONGO_PROD_DATABASE=marketplace
MONGO_PROD_USER=your_username
MONGO_PROD_PASS=your_password
```

### 4. Running the Server

```bash
# Development
npm run dev

# Production
npm run build
npm start
```

## MCP Tools

### `mongo_connect`
Connect to a MongoDB environment.

```typescript
mongo_connect({ environment: "production" })
```

### `mongo_execute`
Execute any mongosh command.

```typescript
mongo_execute({
  command: "db.users.find({}).limit(5)",
  timeout: 30000,
  explain: false
})
```

### `mongo_query`
Structured query with validation.

```typescript
mongo_query({
  collection: "users",
  operation: "find",
  filter: { status: "active" },
  options: { limit: 10, sort: { createdAt: -1 } }
})
```

### `mongo_collections`
Get collection information.

```typescript
mongo_collections({ action: "list" })
mongo_collections({ action: "describe", collection: "users" })
```

### `mongo_docs`
Access collection documentation (if available).

```typescript
mongo_docs({ collection: "users", type: "schema" })
```

## Configuration Options

### Connection Properties

| Property | Type | Description |
|----------|------|-------------|
| `name` | string | Human-readable connection name |
| `host` | string | MongoDB host (supports env vars: `${VAR}`) |
| `port` | number | MongoDB port |
| `database` | string | Database name |
| `username` | string? | Username (supports env vars) |
| `password` | string? | Password (supports env vars) |
| `authSource` | string? | Authentication database |
| `authMechanism` | string? | Auth mechanism (e.g., SCRAM-SHA-256) |
| `options` | object? | Additional MongoDB options |
| `notes` | string? | Documentation/notes |
| `collections` | object? | Collection descriptions |

### MongoDB Options

| Option | Type | Description |
|--------|------|-------------|
| `readPreference` | string | Read preference (primary, secondary, etc.) |
| `retryWrites` | boolean | Enable retryable writes |
| `serverSelectionTimeoutMS` | number | Server selection timeout |
| `connectTimeoutMS` | number | Connection timeout |
| `directConnection` | boolean | Direct connection (bypass discovery) |
| `maxPoolSize` | number | Maximum connection pool size |

## Environment Variable Substitution

Use `${VARIABLE_NAME}` syntax in connection strings to reference environment variables:

```json
{
  "host": "${MONGO_HOST}",
  "username": "${MONGO_USER}",
  "password": "${MONGO_PASS}"
}
```

## Security Best Practices

1. **Never commit credentials** to version control
2. **Use environment variables** for all sensitive data
3. **Use read-only accounts** when possible
4. **Configure appropriate timeouts** for production environments
5. **Use SSH tunnels** for remote connections
6. **Enable connection pooling** for better performance

## Examples

See the `examples/` directory for:
- Connection configuration templates
- Environment variable examples
- Common query patterns
- Collection documentation formats

## Troubleshooting

### Connection Issues

1. **Check environment variables**: Ensure all referenced variables are set
2. **Verify network connectivity**: Test SSH tunnels and VPN connections
3. **Check authentication**: Verify credentials and auth mechanisms
4. **Review timeouts**: Adjust timeout values for slow connections

### Common Errors

- `CONFIG_NOT_FOUND`: No configuration file found in search paths
- `ENV_VAR_NOT_SET`: Referenced environment variable is not defined
- `CONNECTION_FAILED`: Network or authentication issues
- `NOT_CONNECTED`: Attempting operations without active connection

## License

MIT