/**
 * MongoDB Execute Tool
 * Handles execution of raw MongoDB commands using mongosh syntax with JavaScript evaluation
 */

import { ConnectionManager } from '../connections/manager.js';
import { MongoMCPError } from '../connections/types.js';
import { getSafeResponseHandler } from '../utils/response-handler.js';
import { createContext, runInContext } from 'vm';
import { ObjectId } from 'mongodb';
import fs from 'fs/promises';
import path from 'path';

export class MongoExecuteTool {
  constructor(private connectionManager: ConnectionManager) {}

  async execute(args: any): Promise<{ content: Array<{ type: string; text: string }> }> {
    const { command, connectionString, timeout = 30000, explain = false, maxResults = 100, outputFile } = args;

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

      console.error(`🔍 Executing: ${command}${outputFile ? ` -> ${outputFile}` : ''}`);

      // If outputFile is specified, handle file export
      if (outputFile) {
        return await this.executeWithFileOutput(db, command, outputFile, { timeout, explain });
      }

      // Regular execution with LLM-safe limits
      const startTime = Date.now();
      const result = await this.executeJavaScriptCommand(db, command, { timeout, explain, maxResults });
      const executionTime = Date.now() - startTime;

      // Data is already limited at query level, no need for additional truncation
      let finalData = result;

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

  private async executeWithFileOutput(db: any, command: string, outputFile: string, options: { timeout: number; explain: boolean }): Promise<{ content: Array<{ type: string; text: string }> }> {
    try {
      // Validate file path
      const resolvedPath = path.resolve(outputFile);
      const dir = path.dirname(resolvedPath);

      // Ensure directory exists
      await fs.mkdir(dir, { recursive: true });

      console.error(`📁 Exporting to: ${resolvedPath}`);

      // Execute command without limits for full export
      const startTime = Date.now();
      const result = await this.executeJavaScriptCommand(db, command, {
        timeout: options.timeout,
        explain: options.explain,
        maxResults: Number.MAX_SAFE_INTEGER // No limit for file export
      });
      const executionTime = Date.now() - startTime;

      // Write results to file
      let documentCount = 0;
      let fileSize = 0;

      if (Array.isArray(result)) {
        documentCount = result.length;
        const jsonData = JSON.stringify(result, null, 2);
        await fs.writeFile(resolvedPath, jsonData, 'utf8');
        fileSize = Buffer.byteLength(jsonData, 'utf8');
      } else {
        documentCount = 1;
        const jsonData = JSON.stringify(result, null, 2);
        await fs.writeFile(resolvedPath, jsonData, 'utf8');
        fileSize = Buffer.byteLength(jsonData, 'utf8');
      }

      // Return summary instead of actual data
      const summary = {
        success: true,
        message: `Data exported successfully`,
        details: {
          outputFile: resolvedPath,
          documentCount,
          fileSize: this.formatBytes(fileSize),
          executionTime: `${executionTime}ms`,
          command: command
        }
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };

    } catch (error) {
      throw new MongoMCPError(
        `File export failed: ${error instanceof Error ? error.message : String(error)}`,
        'FILE_EXPORT_ERROR',
        error
      );
    }
  }

  private async executeJavaScriptCommand(db: any, command: string, options: { timeout: number; explain: boolean; maxResults: number }): Promise<any> {
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

      // Inject limit for cursor-returning queries to prevent large responses (unless exporting to file)
      if (options.maxResults < Number.MAX_SAFE_INTEGER) {
        executableCommand = this.injectLimitIfNeeded(executableCommand, options.maxResults);
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

  private injectLimitIfNeeded(command: string, maxResults: number): string {
    // Check if the command returns a cursor that could have large results
    const cursorMethods = ['find(', 'aggregate('];
    const hasCursorMethod = cursorMethods.some(method => command.includes(method));

    if (!hasCursorMethod) {
      return command; // Not a cursor-returning query, no limit needed
    }

    // Check if limit is already specified
    if (command.includes('.limit(')) {
      return command; // User has already specified a limit
    }

    // Check if there are other cursor methods that might conflict
    const hasConflictingMethods = command.includes('.forEach(') ||
                                  command.includes('.map(') ||
                                  command.includes('.explain(') ||
                                  command.includes('.count(');

    if (hasConflictingMethods) {
      return command; // Don't inject limit if there are conflicting cursor methods
    }

    // Find the position to inject .limit() - before .toArray() or at the end
    const toArrayIndex = command.lastIndexOf('.toArray()');
    if (toArrayIndex !== -1) {
      // Inject before .toArray()
      return command.slice(0, toArrayIndex) + `.limit(${maxResults})` + command.slice(toArrayIndex);
    }

    // Check for other terminators like .sort(), .skip(), etc.
    const terminators = ['.sort(', '.skip(', '.project(', '.hint('];
    let lastTerminatorIndex = -1;
    let lastTerminatorEnd = -1;

    for (const terminator of terminators) {
      const index = command.lastIndexOf(terminator);
      if (index > lastTerminatorIndex) {
        lastTerminatorIndex = index;
        // Find the closing parenthesis for this terminator
        let parenCount = 0;
        let startSearch = index + terminator.length;
        for (let i = startSearch; i < command.length; i++) {
          if (command[i] === '(') parenCount++;
          else if (command[i] === ')') {
            if (parenCount === 0) {
              lastTerminatorEnd = i + 1;
              break;
            }
            parenCount--;
          }
        }
      }
    }

    if (lastTerminatorEnd > 0) {
      // Inject after the last terminator
      return command.slice(0, lastTerminatorEnd) + `.limit(${maxResults})` + command.slice(lastTerminatorEnd);
    }

    // Default: append at the end if it's a simple query
    if (command.endsWith(')')) {
      return command + `.limit(${maxResults})`;
    }

    return command; // Couldn't determine safe injection point
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';

    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

}