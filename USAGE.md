# MongoDB MCP Server Usage Guide

## 🚀 Quick Start

### 1. Initial Setup

```bash
# Install dependencies
npm install

# Run interactive setup
npm run setup

# Build the project
npm run build

# Test the server
npm run dev
```

### 2. Configuration

The server discovers configuration files in this order:
1. `MONGO_MCP_CONFIG` environment variable
2. `./mongo-connections.json` (current directory)
3. `~/.mongo-mcp/connections.json` (user home)

## 🔧 Configuration Examples

### Basic Local Setup
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
    }
  }
}
```

### Production Setup with Environment Variables
```json
{
  "connections": {
    "prod": {
      "name": "Production",
      "host": "${MONGO_PROD_HOST}",
      "port": "${MONGO_PROD_PORT}",
      "database": "${MONGO_PROD_DATABASE}",
      "username": "${MONGO_PROD_USER}",
      "password": "${MONGO_PROD_PASS}",
      "authSource": "admin",
      "authMechanism": "SCRAM-SHA-256",
      "options": {
        "readPreference": "secondaryPreferred",
        "directConnection": true
      },
      "notes": "Production - requires VPN"
    }
  }
}
```

### Your Existing Setup (Compatible)
```json
{
  "blackwidow": {
    "name": "Blackwidow Non-Prod",
    "host": "api-blackwidow.prefr.com",
    "port": 3214,
    "database": "marketplace_nonprod",
    "username": "cvdev",
    "password": "CvdevsWr12te",
    "authSource": "marketplace_nonprod",
    "authMechanism": "SCRAM-SHA-256",
    "options": {
      "retryWrites": true,
      "readPreference": "secondaryPreferred"
    }
  }
}
```

## 🛠️ MCP Tools Usage

### mongo_connect
Connect to a MongoDB environment:

```typescript
mongo_connect({ environment: "local" })
mongo_connect({ environment: "prod" })
```

### mongo_execute
Execute raw MongoDB commands:

```typescript
// Simple queries
mongo_execute({ command: "db.users.find({})" })
mongo_execute({ command: "db.products.find({}).limit(5)" })

// With options
mongo_execute({
  command: "db.orders.find({status: 'pending'})",
  timeout: 30000,
  explain: true
})

// Aggregations
mongo_execute({
  command: "db.sales.aggregate([{$group: {_id: '$status', count: {$sum: 1}}}])"
})
```

### mongo_query
Structured queries with validation:

```typescript
// Basic find
mongo_query({
  collection: "users",
  operation: "find",
  filter: { status: "active" },
  options: { limit: 10 }
})

// With sorting and projection
mongo_query({
  collection: "orders",
  operation: "find",
  filter: { total: { $gt: 100 } },
  options: {
    sort: { createdAt: -1 },
    projection: { _id: 1, total: 1, status: 1 },
    limit: 20
  }
})

// Aggregation
mongo_query({
  collection: "sales",
  operation: "aggregate",
  filter: [
    { $match: { date: { $gte: "2024-01-01" } } },
    { $group: { _id: "$product", total: { $sum: "$amount" } } }
  ]
})

// Count documents
mongo_query({
  collection: "users",
  operation: "count",
  filter: { lastLogin: { $gte: "2024-01-01" } }
})
```

### mongo_collections
Collection information and metadata:

```typescript
// List all collections
mongo_collections({ action: "list" })

// Describe a collection (schema, samples)
mongo_collections({ action: "describe", collection: "users" })

// Show indexes
mongo_collections({ action: "indexes", collection: "orders" })

// Collection statistics
mongo_collections({ action: "stats", collection: "products" })
```

## 💡 Performance Tips

### Index Hints
Use index hints for better performance:

```typescript
mongo_query({
  collection: "notification_tracker",
  operation: "find",
  filter: { lastModifiedOn: { $gte: "2024-01-01" } },
  options: {
    hint: "lastModifiedOn_1",  // Use specific index
    limit: 1000
  }
})
```

### Read Preferences
Configure read preferences in connection options:
- `primary`: Read from primary only
- `secondary`: Read from secondary only
- `secondaryPreferred`: Prefer secondary, fallback to primary
- `primaryPreferred`: Prefer primary, fallback to secondary

### Connection Pooling
The server automatically manages connection pooling. Configure in options:

```json
{
  "options": {
    "maxPoolSize": 10,
    "minPoolSize": 2,
    "maxIdleTimeMS": 30000
  }
}
```

## 🔒 Security Features

### Read-Only Mode
The server includes security validation to prevent accidental writes. Dangerous operations are blocked by default.

### Environment Variable Substitution
Keep credentials secure using environment variables:

```bash
# .env file
MONGO_PROD_HOST=localhost
MONGO_PROD_USER=myuser
MONGO_PROD_PASS=mypassword
```

### Input Validation
All queries are validated for:
- SQL injection patterns
- Dangerous JavaScript code
- Malformed queries
- Excessive complexity

## 🐛 Troubleshooting

### Connection Issues

**"Connection refused"**
- Check if MongoDB is running
- Verify host and port
- Check firewall settings
- Ensure SSH tunnel is active (if required)

**"Authentication failed"**
- Verify username/password
- Check authSource and authMechanism
- Ensure environment variables are set

**"Host not found"**
- Check host address
- Verify VPN connection
- Check DNS resolution

### Performance Issues

**"Query timeout"**
- Add appropriate indexes
- Use query hints
- Limit result sets
- Simplify complex queries

**"Slow queries"**
- Use `explain: true` to analyze query plans
- Add compound indexes for multiple field queries
- Consider aggregation pipelines for complex operations

### Configuration Issues

**"Config not found"**
- Check file paths and permissions
- Verify JSON syntax
- Ensure environment variables are set

## 📋 Common Patterns

### Daily Notification Volumes
```typescript
mongo_query({
  collection: "notification_tracker",
  operation: "aggregate",
  filter: [
    { $match: { lastModifiedOn: { $gte: "2024-01-01" } } },
    { $group: {
      _id: { $dateToString: { format: "%Y-%m-%d", date: "$lastModifiedOn" } },
      count: { $sum: 1 }
    }},
    { $sort: { _id: -1 } }
  ]
})
```

### Template Usage Analysis
```typescript
mongo_query({
  collection: "notification_tracker",
  operation: "aggregate",
  filter: [
    { $match: { channel: "WHATSAPP" } },
    { $group: {
      _id: "$whatsappTemplateName",
      count: { $sum: 1 },
      success: { $sum: { $cond: [{ $eq: ["$status", "SUCCESS"] }, 1, 0] } }
    }},
    { $sort: { count: -1 } },
    { $limit: 10 }
  ]
})
```

### Recent Errors
```typescript
mongo_query({
  collection: "notification_tracker",
  operation: "find",
  filter: {
    status: "FAILED",
    lastModifiedOn: { $gte: "2024-01-01" }
  },
  options: {
    sort: { lastModifiedOn: -1 },
    limit: 50,
    hint: "lastModifiedOn_1"
  }
})
```

## 🤝 Integration with Claude Code

Add this to your Claude Code MCP configuration:

```json
{
  "mongoMcp": {
    "command": "node",
    "args": ["dist/index.js"],
    "cwd": "/path/to/mongo-mcp"
  }
}
```

Then you can ask Claude to:
- "Connect to production and show recent notifications"
- "Count failed notifications by template"
- "Show me the schema for notification_config collection"
- "Find notifications that failed in the last hour"

The server provides intelligent context and suggestions based on your collection documentation and query patterns.