/**
 * MongoDB Collections Tool
 * Handles collection inspection and metadata operations
 */

import { ConnectionManager } from '../connections/manager.js';
import { MongoMCPError } from '../connections/types.js';

export class MongoCollectionsTool {
  constructor(private connectionManager: ConnectionManager) {}

  async execute(args: any): Promise<{ content: Array<{ type: string; text: string }> }> {
    const { action, collection } = args;

    if (!action || typeof action !== 'string') {
      throw new MongoMCPError(
        'Action parameter is required and must be a string',
        'INVALID_ARGS'
      );
    }

    const validActions = ['list', 'describe', 'indexes', 'stats'];
    if (!validActions.includes(action)) {
      throw new MongoMCPError(
        `Invalid action '${action}'. Valid actions: ${validActions.join(', ')}`,
        'INVALID_ACTION'
      );
    }

    if ((action === 'describe' || action === 'indexes' || action === 'stats') && !collection) {
      throw new MongoMCPError(
        `Collection parameter is required for action '${action}'`,
        'COLLECTION_REQUIRED'
      );
    }

    try {
      // Ensure we're connected
      const client = this.connectionManager.getClient();
      const database = this.connectionManager.getCurrentDatabase();
      const db = client.db(database);

      console.error(`🔍 Executing ${action} ${collection ? `on ${collection}` : ''}`);

      let response: string;

      switch (action) {
        case 'list':
          response = await this.listCollections(db);
          break;
        case 'describe':
          response = await this.describeCollection(db, collection);
          break;
        case 'indexes':
          response = await this.getCollectionIndexes(db, collection);
          break;
        case 'stats':
          response = await this.getCollectionStats(db, collection);
          break;
        default:
          throw new MongoMCPError(`Unsupported action: ${action}`, 'UNSUPPORTED_ACTION');
      }

      return {
        content: [
          {
            type: 'text',
            text: response,
          },
        ],
      };
    } catch (error) {
      if (error instanceof MongoMCPError) {
        throw error;
      }

      throw new MongoMCPError(
        `Collections operation failed: ${error instanceof Error ? error.message : String(error)}`,
        'COLLECTIONS_ERROR',
        error
      );
    }
  }

  private async listCollections(db: any): Promise<string> {
    const collections = await db.listCollections().toArray();
    const state = this.connectionManager.getConnectionState();
    const currentConnection = state.currentConnection;

    let response = `📚 **Collections in database '${db.databaseName}'**\n\n`;

    if (collections.length === 0) {
      response += '⚠️ No collections found in this database.\n';
      return response;
    }

    // Sort collections by name
    collections.sort((a: any, b: any) => a.name.localeCompare(b.name));

    response += `Found ${collections.length} collection(s):\n\n`;

    for (const coll of collections) {
      response += `🗂️ **${coll.name}**\n`;

      if (coll.type && coll.type !== 'collection') {
        response += `   - Type: ${coll.type}\n`;
      }

      // Add documentation if available from connection config
      if (currentConnection) {
        const connection = this.connectionManager.getConnection(currentConnection);
        if (connection?.collections?.[coll.name]) {
          response += `   - Description: ${connection.collections[coll.name]}\n`;
        }
      }

      response += '\n';
    }

    response += `💡 **Next Steps**:\n`;
    response += `- Use \`mongo_collections\` with action "describe" to get detailed collection info\n`;
    response += `- Use \`mongo_collections\` with action "indexes" to see available indexes\n`;
    response += `- Use \`mongo_collections\` with action "stats" to get collection statistics\n`;

    return response;
  }

  private async describeCollection(db: any, collectionName: string): Promise<string> {
    try {
      const collection = db.collection(collectionName);

      // Check if collection exists
      const collectionsList = await db.listCollections({ name: collectionName }).toArray();
      if (collectionsList.length === 0) {
        throw new MongoMCPError(`Collection '${collectionName}' does not exist`, 'COLLECTION_NOT_FOUND');
      }

      const collectionInfo = collectionsList[0];

      let response = `🗂️ **Collection: ${collectionName}**\n\n`;

      // Basic info
      response += `**Database**: ${db.databaseName}\n`;
      response += `**Type**: ${collectionInfo.type || 'collection'}\n\n`;

      // Get sample documents to infer schema
      const sampleDocs = await collection.find({}).limit(5).toArray();

      if (sampleDocs.length > 0) {
        response += `**Sample Documents** (${sampleDocs.length} shown):\n`;
        response += '```json\n';
        response += JSON.stringify(sampleDocs, null, 2);
        response += '\n```\n\n';

        // Infer schema from sample documents
        const schema = this.inferSchema(sampleDocs);
        response += `**Inferred Schema**:\n`;
        response += '```json\n';
        response += JSON.stringify(schema, null, 2);
        response += '\n```\n\n';
      } else {
        response += `⚠️ **No documents found** in this collection.\n\n`;
      }

      // Add documentation if available
      const state = this.connectionManager.getConnectionState();
      const currentConnection = state.currentConnection;
      if (currentConnection) {
        const connection = this.connectionManager.getConnection(currentConnection);
        if (connection?.collections?.[collectionName]) {
          response += `**Description**: ${connection.collections[collectionName]}\n\n`;
        }
      }

      response += `💡 **Useful Commands**:\n`;
      response += `- \`mongo_execute\` with "db.${collectionName}.find({})" to query documents\n`;
      response += `- \`mongo_collections\` with action "indexes" to see available indexes\n`;
      response += `- \`mongo_collections\` with action "stats" to get detailed statistics\n`;

      return response;
    } catch (error) {
      if (error instanceof MongoMCPError) {
        throw error;
      }
      throw new MongoMCPError(
        `Failed to describe collection '${collectionName}': ${error instanceof Error ? error.message : String(error)}`,
        'DESCRIBE_ERROR',
        error
      );
    }
  }

  private async getCollectionIndexes(db: any, collectionName: string): Promise<string> {
    try {
      const collection = db.collection(collectionName);

      // Check if collection exists
      const collectionsList = await db.listCollections({ name: collectionName }).toArray();
      if (collectionsList.length === 0) {
        throw new MongoMCPError(`Collection '${collectionName}' does not exist`, 'COLLECTION_NOT_FOUND');
      }

      const indexes = await collection.indexes();

      let response = `📇 **Indexes for collection '${collectionName}'**\n\n`;

      if (indexes.length === 0) {
        response += '⚠️ No indexes found (unusual - every collection should have at least _id index).\n';
        return response;
      }

      response += `Found ${indexes.length} index(es):\n\n`;

      for (const index of indexes) {
        response += `🔍 **${index.name}**\n`;
        response += `- **Keys**: ${JSON.stringify(index.key)}\n`;

        if (index.unique) {
          response += `- **Unique**: Yes\n`;
        }

        if (index.sparse) {
          response += `- **Sparse**: Yes\n`;
        }

        if (index.partialFilterExpression) {
          response += `- **Partial Filter**: ${JSON.stringify(index.partialFilterExpression)}\n`;
        }

        if (index.expireAfterSeconds !== undefined) {
          response += `- **TTL**: ${index.expireAfterSeconds} seconds\n`;
        }

        response += '\n';
      }

      response += `💡 **Performance Tips**:\n`;
      response += `- Use index names with hint() for better performance\n`;
      response += `- Example: \`mongo_execute\` with "db.${collectionName}.find({}).hint('index_name')"\n`;

      return response;
    } catch (error) {
      if (error instanceof MongoMCPError) {
        throw error;
      }
      throw new MongoMCPError(
        `Failed to get indexes for collection '${collectionName}': ${error instanceof Error ? error.message : String(error)}`,
        'INDEXES_ERROR',
        error
      );
    }
  }

  private async getCollectionStats(db: any, collectionName: string): Promise<string> {
    try {
      const collection = db.collection(collectionName);

      // Check if collection exists
      const collectionsList = await db.listCollections({ name: collectionName }).toArray();
      if (collectionsList.length === 0) {
        throw new MongoMCPError(`Collection '${collectionName}' does not exist`, 'COLLECTION_NOT_FOUND');
      }

      const stats = await db.stats();
      const collStats = await collection.stats();

      let response = `📊 **Statistics for collection '${collectionName}'**\n\n`;

      // Collection stats
      response += `**Collection Statistics**:\n`;
      response += `- **Document Count**: ${collStats.count?.toLocaleString() || 'N/A'}\n`;
      response += `- **Average Document Size**: ${this.formatBytes(collStats.avgObjSize || 0)}\n`;
      response += `- **Total Size**: ${this.formatBytes(collStats.size || 0)}\n`;
      response += `- **Storage Size**: ${this.formatBytes(collStats.storageSize || 0)}\n`;
      response += `- **Index Count**: ${collStats.nindexes || 0}\n`;
      response += `- **Total Index Size**: ${this.formatBytes(collStats.totalIndexSize || 0)}\n\n`;

      // Additional details if available
      if (collStats.wiredTiger) {
        response += `**Storage Engine**: WiredTiger\n`;
      }

      if (collStats.capped) {
        response += `**Capped Collection**: Yes\n`;
        if (collStats.maxSize) {
          response += `**Max Size**: ${this.formatBytes(collStats.maxSize)}\n`;
        }
        if (collStats.max) {
          response += `**Max Documents**: ${collStats.max.toLocaleString()}\n`;
        }
      }

      response += `\n**Database Statistics**:\n`;
      response += `- **Database Size**: ${this.formatBytes(stats.dataSize || 0)}\n`;
      response += `- **Storage Size**: ${this.formatBytes(stats.storageSize || 0)}\n`;
      response += `- **Index Size**: ${this.formatBytes(stats.indexSize || 0)}\n`;
      response += `- **Collections**: ${stats.collections || 0}\n\n`;

      // Performance insights
      const avgDocSize = collStats.avgObjSize || 0;
      const docCount = collStats.count || 0;

      response += `**Performance Insights**:\n`;

      if (avgDocSize > 16 * 1024 * 1024) { // 16MB
        response += `⚠️ Large average document size (${this.formatBytes(avgDocSize)})\n`;
      }

      if (docCount > 1000000) {
        response += `📈 Large collection (${docCount.toLocaleString()} documents)\n`;
      }

      const indexSize = collStats.totalIndexSize || 0;
      const dataSize = collStats.size || 0;
      if (indexSize > dataSize) {
        response += `⚠️ Index size (${this.formatBytes(indexSize)}) exceeds data size (${this.formatBytes(dataSize)})\n`;
      }

      return response;
    } catch (error) {
      if (error instanceof MongoMCPError) {
        throw error;
      }
      throw new MongoMCPError(
        `Failed to get stats for collection '${collectionName}': ${error instanceof Error ? error.message : String(error)}`,
        'STATS_ERROR',
        error
      );
    }
  }

  private inferSchema(documents: any[]): any {
    const schema: any = {};

    if (documents.length === 0) {
      return schema;
    }

    for (const doc of documents) {
      this.mergeSchema(schema, doc);
    }

    return schema;
  }

  private mergeSchema(schema: any, obj: any, depth = 0): void {
    if (depth > 3) return; // Limit recursion depth

    for (const [key, value] of Object.entries(obj)) {
      if (value === null || value === undefined) {
        if (!schema[key]) {
          schema[key] = { type: 'null', nullable: true };
        } else {
          schema[key].nullable = true;
        }
        continue;
      }

      const type = Array.isArray(value) ? 'array' : typeof value;

      if (!schema[key]) {
        schema[key] = { type };

        if (type === 'object' && !Array.isArray(value)) {
          schema[key].properties = {};
          this.mergeSchema(schema[key].properties, value, depth + 1);
        } else if (type === 'array' && Array.isArray(value) && value.length > 0) {
          schema[key].items = {};
          // Infer array item schema from first item
          const firstItem = value[0];
          if (typeof firstItem === 'object' && firstItem !== null) {
            this.mergeSchema(schema[key].items, firstItem, depth + 1);
          } else {
            schema[key].items.type = typeof firstItem;
          }
        }
      } else {
        // Merge types if different
        if (schema[key].type !== type) {
          if (!Array.isArray(schema[key].type)) {
            schema[key].type = [schema[key].type, type];
          } else if (!schema[key].type.includes(type)) {
            schema[key].type.push(type);
          }
        }
      }
    }
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';

    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}