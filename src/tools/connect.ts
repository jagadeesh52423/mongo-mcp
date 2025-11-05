/**
 * MongoDB Connect Tool
 * Handles connection establishment to different MongoDB environments
 */

import { ConnectionManager } from '../connections/manager.js';
import { MongoMCPError } from '../connections/types.js';

export class MongoConnectTool {
  constructor(private connectionManager: ConnectionManager) {}

  async execute(args: any): Promise<{ content: Array<{ type: string; text: string }> }> {
    const { environment } = args;

    if (!environment || typeof environment !== 'string') {
      throw new MongoMCPError(
        'Environment parameter is required and must be a string',
        'INVALID_ARGS'
      );
    }

    try {
      // Check if environment exists
      const availableConnections = this.connectionManager.getAvailableConnections();
      if (!availableConnections.includes(environment)) {
        throw new MongoMCPError(
          `Environment '${environment}' not found. Available: ${availableConnections.join(', ')}`,
          'ENVIRONMENT_NOT_FOUND'
        );
      }

      // Get connection details for display
      const connection = this.connectionManager.getConnection(environment);
      if (!connection) {
        throw new MongoMCPError(
          `Failed to get connection details for '${environment}'`,
          'CONNECTION_DETAILS_ERROR'
        );
      }

      // Validate connection before attempting to connect
      const validationErrors = this.connectionManager.validateConnection(connection);
      if (validationErrors.length > 0) {
        throw new MongoMCPError(
          `Connection validation failed:\n${validationErrors.join('\n')}`,
          'CONNECTION_VALIDATION_ERROR'
        );
      }

      // Attempt connection
      const result = await this.connectionManager.connect(environment);

      // Get current state for detailed response
      const state = this.connectionManager.getConnectionState();

      let response = `${result}\n\n`;
      response += `📊 **Connection Details:**\n`;
      response += `- **Name**: ${connection.name}\n`;
      response += `- **Host**: ${connection.host}:${connection.port}\n`;
      response += `- **Database**: ${connection.database}\n`;
      response += `- **Auth**: ${connection.authMechanism || 'None'}\n`;
      response += `- **Read Preference**: ${connection.options?.readPreference || 'primary'}\n`;

      if (connection.notes) {
        response += `\n📝 **Notes**: ${connection.notes}\n`;
      }

      if (connection.collections && Object.keys(connection.collections).length > 0) {
        response += `\n📚 **Known Collections**:\n`;
        Object.entries(connection.collections).forEach(([name, description]) => {
          response += `- **${name}**: ${description}\n`;
        });
      }

      response += `\n⏰ **Connected at**: ${state.connectionStartTime?.toISOString()}\n`;

      // Add helpful next steps
      response += `\n💡 **Next Steps**:\n`;
      response += `- Use \`mongo_collections\` to list all collections\n`;
      response += `- Use \`mongo_execute\` to run any MongoDB commands\n`;

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
        `Connection failed: ${error instanceof Error ? error.message : String(error)}`,
        'CONNECTION_ERROR',
        error
      );
    }
  }
}