/**
 * API Server Module
 * 
 * Express-based REST API server with TypeScript.
 * Provides endpoints for user management and data operations.
 */

import express, { Request, Response, NextFunction, Router } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { body, validationResult } from 'express-validator';

/**
 * API Response wrapper interface
 */
interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: number;
}

/**
 * User interface
 */
interface User {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
}

/**
 * Create User request body
 */
interface CreateUserRequest {
  name: string;
  email: string;
  password: string;
}

// In-memory store (replace with database in production)
const users: Map<string, User> = new Map();

/**
 * Create success response
 */
function success<T>(data: T): ApiResponse<T> {
  return {
    success: true,
    data,
    timestamp: Date.now(),
  };
}

/**
 * Create error response
 */
function error(message: string): ApiResponse<never> {
  return {
    success: false,
    error: message,
    timestamp: Date.now(),
  };
}

/**
 * Generate unique ID
 */
function generateId(): string {
  return Math.random().toString(36).substring(2, 15);
}

/**
 * Validate request middleware
 */
function validateRequest(req: Request, res: Response, next: NextFunction): void {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json(error(errors.array()[0].msg));
    return;
  }
  next();
}

/**
 * Create API router
 */
function createApiRouter(): Router {
  const router = Router();

  /**
   * GET /health - Health check endpoint
   */
  router.get('/health', (_req: Request, res: Response) => {
    res.json(success({ status: 'ok', uptime: process.uptime() }));
  });

  /**
   * GET /users - List all users
   */
  router.get('/users', (_req: Request, res: Response) => {
    const userList = Array.from(users.values());
    res.json(success(userList));
  });

  /**
   * GET /users/:id - Get user by ID
   */
  router.get('/users/:id', (req: Request, res: Response) => {
    const user = users.get(req.params.id);
    if (!user) {
      res.status(404).json(error('User not found'));
      return;
    }
    res.json(success(user));
  });

  /**
   * POST /users - Create new user
   */
  router.post(
    '/users',
    [
      body('name').trim().isLength({ min: 1 }).withMessage('Name is required'),
      body('email').isEmail().withMessage('Valid email is required'),
      body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    ],
    validateRequest,
    (req: Request<unknown, unknown, CreateUserRequest>, res: Response) => {
      const { name, email } = req.body;
      
      const user: User = {
        id: generateId(),
        name,
        email,
        createdAt: new Date(),
      };
      
      users.set(user.id, user);
      res.status(201).json(success(user));
    }
  );

  /**
   * DELETE /users/:id - Delete user
   */
  router.delete('/users/:id', (req: Request, res: Response) => {
    if (!users.has(req.params.id)) {
      res.status(404).json(error('User not found'));
      return;
    }
    users.delete(req.params.id);
    res.json(success({ deleted: true }));
  });

  return router;
}

/**
 * Create and configure Express application
 */
export function createApp(): express.Application {
  const app = express();

  // Security middleware
  app.use(helmet());
  app.use(cors());

  // Body parsing
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // API routes
  app.use('/api', createApiRouter());

  // Error handling
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err.stack);
    res.status(500).json(error('Internal server error'));
  });

  return app;
}

/**
 * Start the server
 */
export function startServer(port: number = 3000): void {
  const app = createApp();
  
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}

// Start if running directly
if (require.main === module) {
  startServer();
}
