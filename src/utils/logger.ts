import winston from 'winston';
import path from 'path';

const logFormat = winston.format.printf(({ level, message, timestamp, storeId }) => {
  const storePrefix = storeId ? `[Store ${storeId}]` : '';
  return `${timestamp} ${level.toUpperCase()} ${storePrefix} ${message}`;
});

export const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    logFormat
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        logFormat
      )
    }),
    new winston.transports.File({ 
      filename: 'logs/error.log', 
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    new winston.transports.File({ 
      filename: 'logs/combined.log',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
  ],
});

// Helper to create a child logger with store context
export const createStoreLogger = (storeId: number) => {
  return logger.child({ storeId });
};
