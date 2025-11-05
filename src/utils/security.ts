/**
 * Security Utilities
 * Input validation and sanitization for MongoDB operations
 */

import { MongoMCPError } from '../connections/types.js';

export class SecurityValidator {
  // List of potentially dangerous operations that should be restricted
  private static readonly DANGEROUS_OPERATIONS = [
    'drop',
    'dropDatabase',
    'deleteMany',
    'replaceOne',
    'updateMany',
    'insertMany',
    'createIndex',
    'dropIndex',
    'createCollection',
    'renameCollection'
  ];

  // List of administrative commands that should be restricted
  private static readonly ADMIN_COMMANDS = [
    'serverStatus',
    'replSetGetStatus',
    'isMaster',
    'buildInfo',
    'hostInfo',
    'listCommands',
    'getCmdLineOpts',
    'getParameter',
    'setParameter'
  ];

  /**
   * Validate and sanitize a MongoDB command string
   */
  static validateCommand(command: string, options: { allowWrites?: boolean; allowAdmin?: boolean } = {}): string {
    if (!command || typeof command !== 'string') {
      throw new MongoMCPError('Command must be a non-empty string', 'INVALID_COMMAND');
    }

    const trimmedCommand = command.trim();

    // Check for empty command
    if (!trimmedCommand) {
      throw new MongoMCPError('Command cannot be empty', 'EMPTY_COMMAND');
    }

    // Check for dangerous characters that could indicate injection attempts
    this.checkForInjectionPatterns(trimmedCommand);

    // Check for dangerous operations if writes are not allowed
    if (!options.allowWrites) {
      this.checkForWriteOperations(trimmedCommand);
    }

    // Check for administrative commands if admin operations are not allowed
    if (!options.allowAdmin) {
      this.checkForAdminOperations(trimmedCommand);
    }

    // Validate command syntax
    this.validateCommandSyntax(trimmedCommand);

    return trimmedCommand;
  }

  /**
   * Validate MongoDB filter objects
   */
  static validateFilter(filter: any): any {
    if (filter === null || filter === undefined) {
      return {};
    }

    if (typeof filter !== 'object' || Array.isArray(filter)) {
      throw new MongoMCPError('Filter must be an object', 'INVALID_FILTER');
    }

    // Deep validation of filter object
    return this.sanitizeObject(filter, 'filter');
  }

  /**
   * Validate MongoDB options objects
   */
  static validateOptions(options: any): any {
    if (options === null || options === undefined) {
      return {};
    }

    if (typeof options !== 'object' || Array.isArray(options)) {
      throw new MongoMCPError('Options must be an object', 'INVALID_OPTIONS');
    }

    return this.sanitizeObject(options, 'options');
  }

  /**
   * Check for potential injection patterns
   */
  private static checkForInjectionPatterns(command: string): void {
    // Check for JavaScript code injection patterns
    const dangerousPatterns = [
      /eval\s*\(/i,
      /function\s*\(/i,
      /new\s+Function/i,
      /constructor/i,
      /prototype/i,
      /__proto__/i,
      /process\./i,
      /require\s*\(/i,
      /import\s+/i,
      /global\./i,
      /this\./i,
      /\$where/i
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(command)) {
        throw new MongoMCPError(
          `Command contains potentially dangerous pattern: ${pattern.source}`,
          'DANGEROUS_PATTERN'
        );
      }
    }

    // Check for excessive nesting or complexity that could indicate DoS attempts
    const openBraces = (command.match(/\{/g) || []).length;
    const closeBraces = (command.match(/\}/g) || []).length;

    if (openBraces !== closeBraces) {
      throw new MongoMCPError('Unbalanced braces in command', 'MALFORMED_COMMAND');
    }

    if (openBraces > 50) {
      throw new MongoMCPError('Command complexity too high', 'COMPLEX_COMMAND');
    }
  }

  /**
   * Check for write operations when writes are not allowed
   */
  private static checkForWriteOperations(command: string): void {
    for (const operation of this.DANGEROUS_OPERATIONS) {
      const pattern = new RegExp(`\\.${operation}\\s*\\(`, 'i');
      if (pattern.test(command)) {
        throw new MongoMCPError(
          `Write operation '${operation}' is not allowed`,
          'WRITE_OPERATION_FORBIDDEN'
        );
      }
    }

    // Check for insert, update, delete operations
    const writePatterns = [
      /\.(insert|insertOne|insertMany)\s*\(/i,
      /\.(update|updateOne|updateMany|replaceOne)\s*\(/i,
      /\.(delete|deleteOne|deleteMany|remove)\s*\(/i,
      /\.(save|upsert)\s*\(/i
    ];

    for (const pattern of writePatterns) {
      if (pattern.test(command)) {
        throw new MongoMCPError(
          'Write operations are not allowed in read-only mode',
          'WRITE_OPERATION_FORBIDDEN'
        );
      }
    }
  }

  /**
   * Check for administrative operations when admin operations are not allowed
   */
  private static checkForAdminOperations(command: string): void {
    for (const adminCommand of this.ADMIN_COMMANDS) {
      const pattern = new RegExp(`\\.${adminCommand}\\s*\\(`, 'i');
      if (pattern.test(command)) {
        throw new MongoMCPError(
          `Administrative operation '${adminCommand}' is not allowed`,
          'ADMIN_OPERATION_FORBIDDEN'
        );
      }
    }

    // Check for admin database access
    if (/db\.admin\(\)/i.test(command) || /db\.runCommand/i.test(command)) {
      throw new MongoMCPError(
        'Administrative database operations are not allowed',
        'ADMIN_OPERATION_FORBIDDEN'
      );
    }
  }

  /**
   * Validate basic command syntax
   */
  private static validateCommandSyntax(command: string): void {
    // Check if command starts with db. (most common pattern)
    if (!command.startsWith('db.')) {
      throw new MongoMCPError(
        'Command should start with "db." for collection operations',
        'INVALID_COMMAND_SYNTAX'
      );
    }

    // Basic syntax validation for common patterns
    const validPatterns = [
      /^db\.[a-zA-Z_][a-zA-Z0-9_]*\./,  // db.collectionName.
      /^db\.getCollection\(/,             // db.getCollection(...)
      /^db\.collection\(/                 // db.collection(...)
    ];

    const isValid = validPatterns.some(pattern => pattern.test(command));
    if (!isValid) {
      throw new MongoMCPError(
        'Invalid command syntax. Use db.collectionName.operation(...) format',
        'INVALID_COMMAND_SYNTAX'
      );
    }
  }

  /**
   * Recursively sanitize an object to prevent injection
   */
  private static sanitizeObject(obj: any, context: string, depth = 0): any {
    if (depth > 10) {
      throw new MongoMCPError(
        `Object nesting too deep in ${context}`,
        'OBJECT_TOO_DEEP'
      );
    }

    if (obj === null || obj === undefined) {
      return obj;
    }

    // Handle primitive types
    if (typeof obj !== 'object' || obj instanceof Date || obj instanceof RegExp) {
      return this.sanitizePrimitive(obj, context);
    }

    // Handle arrays
    if (Array.isArray(obj)) {
      if (obj.length > 1000) {
        throw new MongoMCPError(
          `Array too large in ${context} (max 1000 elements)`,
          'ARRAY_TOO_LARGE'
        );
      }
      return obj.map((item, index) =>
        this.sanitizeObject(item, `${context}[${index}]`, depth + 1)
      );
    }

    // Handle objects
    const keys = Object.keys(obj);
    if (keys.length > 100) {
      throw new MongoMCPError(
        `Object has too many keys in ${context} (max 100)`,
        'OBJECT_TOO_LARGE'
      );
    }

    const sanitized: any = {};
    for (const key of keys) {
      // Validate key names
      this.validateObjectKey(key, context);
      sanitized[key] = this.sanitizeObject(obj[key], `${context}.${key}`, depth + 1);
    }

    return sanitized;
  }

  /**
   * Sanitize primitive values
   */
  private static sanitizePrimitive(value: any, context: string): any {
    if (typeof value === 'string') {
      // Check string length
      if (value.length > 10000) {
        throw new MongoMCPError(
          `String too long in ${context} (max 10000 characters)`,
          'STRING_TOO_LONG'
        );
      }

      // Check for dangerous string patterns
      const dangerousStringPatterns = [
        /javascript:/i,
        /data:text\/html/i,
        /vbscript:/i,
        /<script/i,
        /eval\s*\(/i,
        /function\s*\(/i
      ];

      for (const pattern of dangerousStringPatterns) {
        if (pattern.test(value)) {
          throw new MongoMCPError(
            `Dangerous pattern in string value: ${context}`,
            'DANGEROUS_STRING_PATTERN'
          );
        }
      }
    }

    if (typeof value === 'number') {
      // Check for unsafe numbers
      if (!Number.isFinite(value)) {
        throw new MongoMCPError(
          `Invalid number in ${context}: ${value}`,
          'INVALID_NUMBER'
        );
      }
    }

    return value;
  }

  /**
   * Validate object keys
   */
  private static validateObjectKey(key: string, context: string): void {
    if (typeof key !== 'string') {
      throw new MongoMCPError(
        `Object key must be a string in ${context}`,
        'INVALID_OBJECT_KEY'
      );
    }

    // Check for dangerous key patterns
    const dangerousKeyPatterns = [
      /^\$/,           // MongoDB operators should be validated separately
      /\./,            // Dots in keys can cause issues
      /constructor/i,
      /prototype/i,
      /__proto__/i
    ];

    for (const pattern of dangerousKeyPatterns) {
      if (pattern.test(key)) {
        throw new MongoMCPError(
          `Potentially dangerous key name in ${context}: ${key}`,
          'DANGEROUS_KEY_NAME'
        );
      }
    }

    if (key.length > 100) {
      throw new MongoMCPError(
        `Key name too long in ${context} (max 100 characters)`,
        'KEY_TOO_LONG'
      );
    }
  }

  /**
   * Validate collection name
   */
  static validateCollectionName(name: string): string {
    if (!name || typeof name !== 'string') {
      throw new MongoMCPError('Collection name must be a non-empty string', 'INVALID_COLLECTION_NAME');
    }

    const trimmed = name.trim();

    if (!trimmed) {
      throw new MongoMCPError('Collection name cannot be empty', 'EMPTY_COLLECTION_NAME');
    }

    // Check for invalid characters
    const invalidChars = /[/\\. "$*<>:|?]/;
    if (invalidChars.test(trimmed)) {
      throw new MongoMCPError(
        'Collection name contains invalid characters',
        'INVALID_COLLECTION_NAME'
      );
    }

    // Check length limits
    if (trimmed.length > 120) {
      throw new MongoMCPError(
        'Collection name too long (max 120 characters)',
        'COLLECTION_NAME_TOO_LONG'
      );
    }

    // Check for reserved names
    const reservedNames = ['admin', 'local', 'config'];
    if (reservedNames.includes(trimmed.toLowerCase())) {
      throw new MongoMCPError(
        `Collection name '${trimmed}' is reserved`,
        'RESERVED_COLLECTION_NAME'
      );
    }

    return trimmed;
  }

  /**
   * Check if a command appears to be safe for execution (read-only operations)
   */
  static isReadOnlyCommand(command: string): boolean {
    const readOnlyPatterns = [
      /^db\.[^.]+\.find\(/,
      /^db\.[^.]+\.findOne\(/,
      /^db\.[^.]+\.count\(/,
      /^db\.[^.]+\.aggregate\(/,
      /^db\.[^.]+\.distinct\(/,
      /^db\.[^.]+\.stats\(/,
      /^db\.[^.]+\.explain\(/
    ];

    return readOnlyPatterns.some(pattern => pattern.test(command.trim()));
  }
}