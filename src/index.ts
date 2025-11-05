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
import { MongoConnectTool } from './tools/connect.js';
import { MongoExecuteTool } from './tools/execute.js';
import { MongoCollectionsTool } from './tools/collections.js';
import { cleanupSafeResponseHandler, getSafeResponseHandler } from './utils/response-handler.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

class MongoMCPServer {
  private server: Server;
  private connectionManager: ConnectionManager;
  private tools: {
    connect: MongoConnectTool;
    execute: MongoExecuteTool;
    collections: MongoCollectionsTool;
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
      connect: new MongoConnectTool(this.connectionManager),
      execute: new MongoExecuteTool(this.connectionManager),
      collections: new MongoCollectionsTool(this.connectionManager),
    };

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'mongo_connect',
            description: 'Connect to a MongoDB environment',
            inputSchema: {
              type: 'object',
              properties: {
                environment: {
                  type: 'string',
                  description: 'Environment name to connect to (e.g., "local", "dev", "prod")',
                },
              },
              required: ['environment'],
            },
          },
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
              },
              required: ['command'],
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
                collection: {
                  type: 'string',
                  description: 'Collection name (required for describe, indexes, stats)',
                },
              },
              required: ['action'],
            },
          },
        ],
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'mongo_connect':
            return await this.tools.connect.execute(args);

          case 'mongo_execute':
            return await this.tools.execute.execute(args);


          case 'mongo_collections':
            return await this.tools.collections.execute(args);

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
      // Initialize connection manager
      await this.connectionManager.initialize();

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
      console.error('📋 Available tools: mongo_connect, mongo_execute, mongo_collections');

      // Display available connections
      const connections = this.connectionManager.getAvailableConnections();
      if (connections.length > 0) {
        console.error(`🔌 Available connections: ${connections.join(', ')}`);
      }

    } catch (error) {
      console.error('❌ Failed to start MongoDB MCP Server:', error);
      process.exit(1);
    }
  }

  async stop(): Promise<void> {
    try {
      // Cleanup response handler temp files
      await cleanupSafeResponseHandler();

      // Disconnect from MongoDB
      await this.connectionManager.disconnect();

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