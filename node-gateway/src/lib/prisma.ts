import { PrismaClient } from '@prisma/client';
import { config } from '../config/env.js';

const globalForPrisma = global as typeof global & { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: config.NODE_ENV === 'development' ? ['error'] : ['error'],
  });

if (config.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
