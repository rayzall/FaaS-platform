/**
 * Jest setup — runs before each test file.
 * Loads .env from the workspace root so Prisma sees DATABASE_URL.
 */
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
