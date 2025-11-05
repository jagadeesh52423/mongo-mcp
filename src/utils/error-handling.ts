/**
 * Error Handling Utilities
 * Centralized error handling and logging for the MongoDB MCP Server
 */

import { MongoMCPError } from '../connections/types.js';

export class ErrorHandler {
  static handle(error: any, context?: string): MongoMCPError {
    // If it's already a MongoMCPError, return as-is
    if (error instanceof MongoMCPError) {
      return error;
    }

    // Handle MongoDB-specific errors
    if (error.name === 'MongoServerError' || error.name === 'MongoError') {
      return this.handleMongoError(error, context);
    }

    // Handle connection errors
    if (error.name === 'MongoNetworkError' || error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      return this.handleConnectionError(error, context);
    }

    // Handle timeout errors
    if (error.name === 'MongoNetworkTimeoutError' || error.code === 'ETIMEDOUT') {
      return this.handleTimeoutError(error, context);
    }

    // Handle authentication errors
    if (error.codeName === 'AuthenticationFailed' || error.code === 18) {
      return this.handleAuthError(error, context);
    }

    // Handle authorization errors
    if (error.codeName === 'Unauthorized' || error.code === 13) {
      return this.handleAuthorizationError(error, context);
    }

    // Handle validation errors
    if (error.name === 'ValidationError' || error.name === 'CastError') {
      return this.handleValidationError(error, context);
    }

    // Handle general errors
    return new MongoMCPError(
      context ? `${context}: ${error.message}` : error.message,
      'GENERAL_ERROR',
      error
    );
  }

  private static handleMongoError(error: any, context?: string): MongoMCPError {
    let message = error.message;
    let code = 'MONGO_ERROR';

    // Specific MongoDB error codes
    switch (error.code) {
      case 11000:
        code = 'DUPLICATE_KEY';
        message = 'Duplicate key error: A document with this key already exists';
        break;
      case 2:
        code = 'BAD_VALUE';
        message = 'Invalid value provided in query or operation';
        break;
      case 14:
        code = 'TYPE_MISMATCH';
        message = 'Type mismatch in query or operation';
        break;
      case 16550:
        code = 'COMMAND_NOT_FOUND';
        message = 'MongoDB command not found or not supported';
        break;
      case 26:
        code = 'NAMESPACE_NOT_FOUND';
        message = 'Collection or database not found';
        break;
      default:
        if (error.codeName) {
          code = error.codeName;
          message = `MongoDB Error (${error.codeName}): ${error.message}`;
        }
    }

    return new MongoMCPError(
      context ? `${context}: ${message}` : message,
      code,
      error
    );
  }

  private static handleConnectionError(error: any, context?: string): MongoMCPError {
    let message = 'Failed to connect to MongoDB';
    let suggestions = '';

    if (error.code === 'ENOTFOUND') {
      message = 'MongoDB host not found. Check your host configuration.';
      suggestions = '\n\nTroubleshooting:\n- Verify the host address is correct\n- Check if VPN or SSH tunnel is required\n- Ensure network connectivity';
    } else if (error.code === 'ECONNREFUSED') {
      message = 'Connection refused by MongoDB server. Check if MongoDB is running and accessible.';
      suggestions = '\n\nTroubleshooting:\n- Verify MongoDB is running on the specified port\n- Check firewall settings\n- Ensure SSH tunnel is active (if required)';
    }

    return new MongoMCPError(
      context ? `${context}: ${message}${suggestions}` : `${message}${suggestions}`,
      'CONNECTION_ERROR',
      error
    );
  }

  private static handleTimeoutError(error: any, context?: string): MongoMCPError {
    const message = 'Operation timed out. The MongoDB server may be overloaded or the query is too complex.';
    const suggestions = '\n\nTroubleshooting:\n- Increase timeout values\n- Simplify the query\n- Add appropriate indexes\n- Use query hints for better performance';

    return new MongoMCPError(
      context ? `${context}: ${message}${suggestions}` : `${message}${suggestions}`,
      'TIMEOUT_ERROR',
      error
    );
  }

  private static handleAuthError(error: any, context?: string): MongoMCPError {
    const message = 'Authentication failed. Check your username and password.';
    const suggestions = '\n\nTroubleshooting:\n- Verify username and password are correct\n- Check if credentials have expired\n- Ensure authSource and authMechanism are correct\n- Verify environment variables are set properly';

    return new MongoMCPError(
      context ? `${context}: ${message}${suggestions}` : `${message}${suggestions}`,
      'AUTHENTICATION_ERROR',
      error
    );
  }

  private static handleAuthorizationError(error: any, context?: string): MongoMCPError {
    const message = 'Authorization failed. You do not have permission to perform this operation.';
    const suggestions = '\n\nTroubleshooting:\n- Check if your user has the required permissions\n- Verify you are connecting to the correct database\n- Contact your database administrator for access rights';

    return new MongoMCPError(
      context ? `${context}: ${message}${suggestions}` : `${message}${suggestions}`,
      'AUTHORIZATION_ERROR',
      error
    );
  }

  private static handleValidationError(error: any, context?: string): MongoMCPError {
    const message = 'Data validation failed. Check your query parameters and data format.';
    const suggestions = '\n\nTroubleshooting:\n- Verify query syntax is correct\n- Check data types match collection schema\n- Ensure required fields are provided\n- Review MongoDB query documentation';

    return new MongoMCPError(
      context ? `${context}: ${message}${suggestions}` : `${message}${suggestions}`,
      'VALIDATION_ERROR',
      error
    );
  }

  /**
   * Log error with appropriate level
   */
  static log(error: MongoMCPError | Error, level: 'error' | 'warn' | 'info' = 'error'): void {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase()}]`;

    if (error instanceof MongoMCPError) {
      console.error(`${prefix} ${error.code}: ${error.message}`);
      if (error.details) {
        console.error(`${prefix} Details:`, error.details);
      }
    } else {
      console.error(`${prefix} ${error.message}`);
      if (error.stack) {
        console.error(`${prefix} Stack:`, error.stack);
      }
    }
  }

  /**
   * Check if error suggests performance issues
   */
  static isPerformanceIssue(error: any): boolean {
    if (error instanceof MongoMCPError) {
      return error.code === 'TIMEOUT_ERROR';
    }

    return (
      error.name === 'MongoNetworkTimeoutError' ||
      error.code === 'ETIMEDOUT' ||
      (error.message && error.message.includes('timeout'))
    );
  }

  /**
   * Check if error suggests configuration issues
   */
  static isConfigurationIssue(error: any): boolean {
    if (error instanceof MongoMCPError) {
      return [
        'CONNECTION_ERROR',
        'AUTHENTICATION_ERROR',
        'AUTHORIZATION_ERROR',
        'CONFIG_NOT_FOUND',
        'ENV_VAR_NOT_SET'
      ].includes(error.code);
    }

    return (
      error.code === 'ENOTFOUND' ||
      error.code === 'ECONNREFUSED' ||
      error.codeName === 'AuthenticationFailed' ||
      error.codeName === 'Unauthorized'
    );
  }

  /**
   * Get user-friendly error message with troubleshooting tips
   */
  static getUserFriendlyMessage(error: any): string {
    const mcpError = this.handle(error);

    let message = `❌ **Error**: ${mcpError.message}\n`;

    if (this.isConfigurationIssue(error)) {
      message += `\n🔧 **Type**: Configuration Issue\n`;
      message += `💡 **Tip**: Check your connection settings and credentials\n`;
    } else if (this.isPerformanceIssue(error)) {
      message += `\n⚡ **Type**: Performance Issue\n`;
      message += `💡 **Tip**: Consider optimizing your query or adding indexes\n`;
    }

    return message;
  }
}