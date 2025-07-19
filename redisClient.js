const redis = require('redis');
const { promisify } = require('util');

// Create Redis client with modern configuration
const redisClient = redis.createClient({
    socket: {
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379,
        reconnectStrategy: (retries) => {
            if (retries > 10) {
                console.error('Too many retries on Redis. Connection terminated');
                return new Error('Too many retries');
            }
            return Math.min(retries * 100, 5000);
        }
    }
});

// Promisify Redis methods
const redisGet = promisify(redisClient.get).bind(redisClient);
const redisSet = promisify(redisClient.set).bind(redisClient);
const redisDel = promisify(redisClient.del).bind(redisClient);
const redisKeys = promisify(redisClient.keys).bind(redisClient);

// Connect to Redis with error handling
(async () => {
    try {
        await redisClient.connect();
        console.log('Successfully connected to Redis');
    } catch (err) {
        console.error('Failed to connect to Redis:', err);
        process.exit(1);
    }
})();

// Event handlers
redisClient.on('error', (err) => {
    console.error('Redis client error:', err);
});

redisClient.on('ready', () => {
    console.log('Redis client is ready');
});

redisClient.on('reconnecting', () => {
    console.log('Redis client reconnecting...');
});

module.exports = {
    redisClient,
    redisGet,
    redisSet,
    redisDel,
    redisKeys
};