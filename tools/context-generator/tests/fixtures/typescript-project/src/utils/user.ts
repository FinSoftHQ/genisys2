/**
 * User management utilities
 */

/**
 * User role type
 */
export type UserRole = 'admin' | 'user' | 'guest';

/**
 * User interface definition
 */
export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  createdAt: Date;
}

/**
 * User creation options
 */
export interface CreateUserOptions {
  role?: UserRole;
  metadata?: Record<string, unknown>;
}

/**
 * Generate a unique ID
 * @returns Unique identifier string
 */
function generateId(): string {
  return Math.random().toString(36).substring(2, 15);
}

/**
 * Create a new user
 * @param name - User's full name
 * @param email - User's email address
 * @param options - Optional user configuration
 * @returns Created user object
 */
export function createUser(
  name: string,
  email: string,
  options: CreateUserOptions = {}
): User {
  const { role = 'user' } = options;
  
  return {
    id: generateId(),
    name,
    email,
    role,
    createdAt: new Date(),
  };
}

/**
 * Validate user email format
 * @param email - Email to validate
 * @returns Whether the email is valid
 */
export function validateEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * User manager class for handling multiple users
 */
export class UserManager {
  private users: Map<string, User> = new Map();

  /**
   * Add a user to the manager
   */
  public add(user: User): void {
    this.users.set(user.id, user);
  }

  /**
   * Get a user by ID
   */
  public get(id: string): User | undefined {
    return this.users.get(id);
  }

  /**
   * Remove a user by ID
   */
  public remove(id: string): boolean {
    return this.users.delete(id);
  }

  /**
   * Get all users
   */
  public getAll(): User[] {
    return Array.from(this.users.values());
  }

  /**
   * Find users by role
   */
  public findByRole(role: UserRole): User[] {
    return this.getAll().filter(user => user.role === role);
  }
}

// Re-export types
export type { UserRole as Role };
