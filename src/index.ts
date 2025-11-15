#!/usr/bin/env node
/**
 * MongoDB MCP Server
 * Main entry point for the Model Context Protocol server
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { ConnectionManager } from './connections/manager.js';
import { MongoMCPError } from './connections/types.js';
import { MongoExecuteTool } from './tools/execute.js';
import { MongoCollectionsTool } from './tools/collections.js';
import { MongoDescribeTool } from './tools/describe.js';
// import { MongoTransferTool } from './tools/transfer.js'; // Temporarily disabled
import { cleanupSafeResponseHandler, getSafeResponseHandler } from './utils/response-handler.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

class MongoMCPServer {
  private server: Server;
  private connectionManager: ConnectionManager;
  private tools: {
    execute: MongoExecuteTool;
    collections: MongoCollectionsTool;
    describe: MongoDescribeTool;
    // transfer: MongoTransferTool; // Temporarily disabled
  };

  constructor() {
    this.server = new Server(
      {
        name: 'mongo-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.connectionManager = new ConnectionManager();

    // Initialize tools
    this.tools = {
      execute: new MongoExecuteTool(this.connectionManager),
      collections: new MongoCollectionsTool(this.connectionManager),
      describe: new MongoDescribeTool(this.connectionManager),
      // transfer: new MongoTransferTool(this.connectionManager), // Temporarily disabled
    };

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'mongo_execute',
            description: 'Execute a MongoDB command using mongosh syntax',
            inputSchema: {
              type: 'object',
              properties: {
                command: {
                  type: 'string',
                  description: 'MongoDB command to execute (e.g., "db.users.find({})")',
                },
                connectionString: {
                  type: 'string',
                  description: 'MongoDB connection string (e.g., "mongodb://localhost:27017/mydb")',
                },
                timeout: {
                  type: 'number',
                  description: 'Timeout in milliseconds (default: 30000)',
                  default: 30000,
                },
                explain: {
                  type: 'boolean',
                  description: 'Include query execution plan',
                  default: false,
                },
                maxResults: {
                  type: 'number',
                  description: 'Maximum number of results to return in response (default: 100). Use to prevent overwhelming responses with large datasets.',
                  default: 100,
                },
                outputFile: {
                  type: 'string',
                  description: 'Optional: Path to save results to file instead of returning to LLM. Use for large datasets to avoid context overflow.',
                },
              },
              required: ['command', 'connectionString'],
            },
          },
          {
            name: 'mongo_collections',
            description: 'Get information about MongoDB collections',
            inputSchema: {
              type: 'object',
              properties: {
                action: {
                  type: 'string',
                  enum: ['list', 'describe', 'indexes', 'stats'],
                  description: 'Action to perform',
                },
                connectionString: {
                  type: 'string',
                  description: 'MongoDB connection string (e.g., "mongodb://localhost:27017/mydb")',
                },
                collection: {
                  type: 'string',
                  description: 'Collection name (required for describe, indexes, stats)',
                },
              },
              required: ['action', 'connectionString'],
            },
          },
          {
            name: 'mongo_describe',
            description: 'Analyze collection schema by sampling documents and extracting field information',
            inputSchema: {
              type: 'object',
              properties: {
                connectionString: {
                  type: 'string',
                  description: 'MongoDB connection string (e.g., "mongodb://localhost:27017/mydb")',
                },
                collection: {
                  type: 'string',
                  description: 'Collection name to analyze',
                },
                limit: {
                  type: 'number',
                  description: 'Number of documents to sample for analysis (0 = all documents, default: 1000)',
                  default: 1000,
                },
                depth: {
                  type: 'number',
                  description: 'Maximum depth for nested field analysis (default: 5)',
                  default: 5,
                },
                outputFile: {
                  type: 'string',
                  description: 'Optional: Path to save sample data for debugging (not returned to LLM)',
                },
                progressive: {
                  type: 'boolean',
                  description: 'Use progressive sampling for large collections (default: true)',
                  default: true,
                },
              },
              required: ['connectionString', 'collection'],
            },
          },
          // mongo_transfer temporarily disabled
        ],
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'mongo_execute':
            return await this.tools.execute.execute(args);

          case 'mongo_collections':
            return await this.tools.collections.execute(args);

          case 'mongo_describe':
            return await this.tools.describe.execute(args);

          // case 'mongo_transfer':
          //   return await this.tools.transfer.execute(args);

          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${name}`
            );
        }
      } catch (error) {
        if (error instanceof MongoMCPError) {
          throw new McpError(
            ErrorCode.InternalError,
            `${error.code}: ${error.message}`,
            error.details
          );
        }

        if (error instanceof McpError) {
          throw error;
        }

        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : String(error)
        );
      }
    });
  }

  async start(): Promise<void> {
    try {
      // Initialize SafeResponseHandler with configuration from environment
      const maxSizeMB = parseInt(process.env.MAX_RESPONSE_SIZE_MB || '10', 10);
      const warningSizeMB = parseInt(process.env.WARNING_RESPONSE_SIZE_MB || '5', 10);
      const maxDocuments = parseInt(process.env.MAX_RESPONSE_DOCUMENTS || '100', 10);

      getSafeResponseHandler({
        maxSizeBytes: maxSizeMB * 1024 * 1024,
        warningSizeBytes: warningSizeMB * 1024 * 1024,
        maxDocuments,
      });

      console.error(`📦 Response limits: Max ${maxSizeMB}MB, Warning ${warningSizeMB}MB, Max docs ${maxDocuments}`);

      // Start the server
      const transport = new StdioServerTransport();
      await this.server.connect(transport);

      console.error('✅ MongoDB MCP Server started successfully');
      console.error('📋 Available tools: mongo_execute, mongo_collections, mongo_describe');
      console.error('💡 Users provide connection strings directly to each tool (with connection pooling for performance)');

    } catch (error) {
      console.error('❌ Failed to start MongoDB MCP Server:', error);
      process.exit(1);
    }
  }

  async stop(): Promise<void> {
    try {
      // Cleanup response handler temp files
      await cleanupSafeResponseHandler();

      // Cleanup connection pool
      await this.connectionManager.cleanup();

      console.error('🛑 MongoDB MCP Server stopped');
    } catch (error) {
      console.error('Error stopping server:', error);
    }
  }
}

// Handle graceful shutdown
const server = new MongoMCPServer();

process.on('SIGINT', async () => {
  await server.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await server.stop();
  process.exit(0);
});

// Start the server
server.start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});