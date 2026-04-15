/**
 * Main entry point for the application
 * @module index
 */

import { createUser, type User } from './utils/user.js';
import { formatDate } from './utils/helpers.js';

/**
 * Application configuration interface
 */
export interface AppConfig {
  /** Application name */
  name: string;
  /** Application version */
  version: string;
  /** Debug mode flag */
  debug: boolean;
}

/**
 * Default application configuration
 */
export const defaultConfig: AppConfig = {
  name: 'TestApp',
  version: '1.0.0',
  debug: false,
};

/**
 * Initialize the application with the given configuration
 * @param config - Application configuration
 * @returns Initialized app instance
 */
export async function initializeApp(config: Partial<AppConfig> = {}): Promise<string> {
  const mergedConfig = { ...defaultConfig, ...config };
  
  if (mergedConfig.debug) {
    console.log('Debug mode enabled');
  }
  
  return `App ${mergedConfig.name} v${mergedConfig.version} initialized`;
}

/**
 * Main application class
 */
export class Application {
  private config: AppConfig;
  private users: User[] = [];

  constructor(config: Partial<AppConfig> = {}) {
    this.config = { ...defaultConfig, ...config };
  }

  /**
   * Start the application
   */
  public async start(): Promise<void> {
    console.log(`Starting ${this.config.name}...`);
  }

  /**
   * Stop the application
   */
  public stop(): void {
    console.log('Stopping application...');
  }

  /**
   * Add a user to the application
   */
  public addUser(name: string, email: string): User {
    const user = createUser(name, email);
    this.users.push(user);
    return user;
  }
}

// Default export
export default Application;
