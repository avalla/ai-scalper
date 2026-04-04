import IORedis from "ioredis";

export function createRedisConnection(): IORedis {
  const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
  return new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
  });
}
