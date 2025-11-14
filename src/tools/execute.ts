/**
 * MongoDB Execute Tool
 * Handles execution of raw MongoDB commands using mongosh syntax with JavaScript evaluation
 */

import { ConnectionManager } from '../connections/manager.js';
import { MongoMCPError } from '../connections/types.js';
import { getSafeResponseHandler } from '../utils/response-handler.js';
import { createContext, runInContext } from 'vm';
import { ObjectId } from 'mongodb';

export class MongoExecuteTool {
  constructor(private connectionManager: ConnectionManager) {}

  async execute(args: any): Promise<{ content: Array<{ type: string; text: string }> }> {
    const { command, connectionString, timeout = 30000, explain = false, maxResults = 100 } = args;

    if (!command || typeof command !== 'string') {
      throw new MongoMCPError(
        'Command parameter is required and must be a string',
        'INVALID_ARGS'
      );
    }

    if (!connectionString || typeof connectionString !== 'string') {
      throw new MongoMCPError(
        'ConnectionString parameter is required and must be a string',
        'INVALID_ARGS'
      );
    }

    try {
      // Get connection from pool
      const { client, database } = await this.connectionManager.getClient(connectionString);
      const db = client.db(database);

      console.error(`🔍 Executing: ${command}`);

      // Execute the command using JavaScript evaluation
      const startTime = Date.now();
      const result = await this.executeJavaScriptCommand(db, command, { timeout, explain });
      const executionTime = Date.now() - startTime;

      // Limit results to maxResults if it's an array
      let finalData = result;
      if (Array.isArray(result) && result.length > maxResults) {
        finalData = result.slice(0, maxResults);
        console.error(`⚠️ Results truncated: showing ${maxResults} of ${result.length} documents`);
      }

      // Format response
      const response = JSON.stringify(finalData, null, 2);

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
        `Command execution failed: ${error instanceof Error ? error.message : String(error)}`,
        'EXECUTION_ERROR',
        error
      );
    } finally {
      // Release the connection back to the pool
      this.connectionManager.releaseConnection(connectionString);
    }
  }

  private async executeJavaScriptCommand(db: any, command: string, options: { timeout: number; explain: boolean }): Promise<any> {
    try {
      // Create a secure execution context with MongoDB database access
      const context = this.createMongoContext(db);

      // Prepare the command for execution
      const normalizedCommand = command.trim();

      // Ensure the command starts with 'db.'
      let executableCommand = normalizedCommand;
      if (!executableCommand.startsWith('db.')) {
        executableCommand = `db.${executableCommand}`;
      }

      // Wrap the command in an async function to handle promises
      const needsToArray = this.needsToArrayConversion(executableCommand);
      if (needsToArray) {
        executableCommand = `(${executableCommand}).toArray()`;
      }

      // Create an async wrapper function
      const wrappedCommand = `
        (async function() {
          try {
            const result = await ${executableCommand};
            return result;
          } catch (error) {
            throw error;
          }
        })()
      `;

      console.error(`📝 Normalized command: ${executableCommand}`);
      console.error(`🔧 Wrapped command: ${wrappedCommand}`);

      // Execute the wrapped command in the secure context
      const resultPromise = runInContext(wrappedCommand, context, {
        timeout: options.timeout,
        displayErrors: true
      });

      const result = await resultPromise;

      return result;
    } catch (error) {
      throw new MongoMCPError(
        `JavaScript execution error: ${error instanceof Error ? error.message : String(error)}`,
        'JS_EXECUTION_ERROR',
        error
      );
    }
  }

  private createMongoContext(db: any): any {
    // Create a secure context with only necessary MongoDB operations
    const context = createContext({
      // Database object
      db: this.createDatabaseProxy(db),

      // Global functions that might be needed
      ObjectId: ObjectId,
      Date: Date,
      RegExp: RegExp,
      Array: Array,
      Object: Object,
      JSON: JSON,
      Math: Math,

      // Console for debugging (limited)
      console: {
        log: console.log,
        error: console.error
      }
    });

    return context;
  }

  private createDatabaseProxy(db: any): any {
    // Create a proxy that dynamically creates collection objects
    return new Proxy({}, {
      get: (target, prop) => {
        if (typeof prop === 'string') {
          // Return a collection proxy
          return this.createCollectionProxy(db.collection(prop));
        }
        return undefined;
      }
    });
  }

  private createCollectionProxy(collection: any): any {
    // Create a proxy that wraps all collection methods
    return new Proxy({}, {
      get: (target, prop) => {
        if (typeof prop === 'string' && typeof collection[prop] === 'function') {
          return collection[prop].bind(collection);
        }
        return collection[prop];
      }
    });
  }

  private needsToArrayConversion(command: string): boolean {
    // Check if the command returns a cursor that needs .toArray()
    const cursorMethods = [
      'find(',
      'aggregate(',
      '.find(',
      '.aggregate('
    ];

    // Don't add toArray() if it's already there or if other cursor methods are chained
    const hasToArray = command.includes('.toArray()');
    const hasOtherCursorMethods = command.includes('.forEach(') ||
                                  command.includes('.map(') ||
                                  command.includes('.explain()');

    return cursorMethods.some(method => command.includes(method)) &&
           !hasToArray &&
           !hasOtherCursorMethods;
  }

  private needsAwait(command: string): boolean {
    // Check if the command needs await (most MongoDB operations are async)
    // Since we're wrapping everything in async function, this is mainly for reference
    const asyncMethods = [
      'findOne(',
      'insertOne(',
      'insertMany(',
      'updateOne(',
      'updateMany(',
      'deleteOne(',
      'deleteMany(',
      'countDocuments(',
      'estimatedDocumentCount(',
      'distinct(',
      'createIndex(',
      'dropIndex(',
      'drop(',
      '.count('
    ];

    return asyncMethods.some(method => command.includes(method));
  }

}