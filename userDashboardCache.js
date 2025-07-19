const redis = require('redis');
const { promisify } = require('util');

const DASHBOARD_CACHE_EXPIRATION = 3600; // 1 hour
const SKILLS_CACHE_EXPIRATION = 86400; // 24 hours
const ARTICLES_CACHE_EXPIRATION = 21600; // 6 hours
const RECOMMENDATIONS_CACHE_EXPIRATION = 1800; // 30 minutes

// Create Redis client
const client = redis.createClient({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD || null
});

// Promisify Redis methods
const redisGet = promisify(client.get).bind(client);
const redisSet = promisify(client.set).bind(client);
const redisDel = promisify(client.del).bind(client);
const redisExpire = promisify(client.expire).bind(client);
const redisKeys = promisify(client.keys).bind(client);

// Handle Redis connection events
client.on('connect', () => {
    console.log('Connected to Redis');
});

client.on('error', (err) => {
    console.error('Redis error:', err);
});

module.exports = {
    // Dashboard caching
    async getDashboard(userId) {
        try {
            const cachedData = await redisGet(`dashboard:${userId}`);
            if (cachedData) {
                return JSON.parse(cachedData);
            }
            return null;
        } catch (error) {
            console.error('Error getting dashboard from cache:', error);
            throw error;
        }
    },

    async setDashboard(userId, dashboardData) {
        try {
            await redisSet(
                `dashboard:${userId}`,
                JSON.stringify(dashboardData),
                'EX',
                DASHBOARD_CACHE_EXPIRATION
            );
            
            // Also update the user's last activity timestamp
            await redisSet(
                `user:${userId}:last_activity`,
                new Date().toISOString(),
                'EX',
                DASHBOARD_CACHE_EXPIRATION * 2
            );
            
            return true;
        } catch (error) {
            console.error('Error setting dashboard cache:', error);
            throw error;
        }
    },

    async invalidateDashboard(userId) {
        try {
            await redisDel(`dashboard:${userId}`);
            return true;
        } catch (error) {
            console.error('Error invalidating dashboard cache:', error);
            throw error;
        }
    },

    // Skills caching
    async getSkillProgress(userId) {
        try {
            const cachedData = await redisGet(`skills:${userId}`);
            if (cachedData) {
                return JSON.parse(cachedData);
            }
            return null;
        } catch (error) {
            console.error('Error getting skills from cache:', error);
            throw error;
        }
    },

    async setSkillProgress(userId, skills) {
        try {
            // First get existing skills to merge progress
            const existingSkills = await this.getSkillProgress(userId) || [];
            
            // Merge new skills with existing ones, preserving progress where possible
            const mergedSkills = skills.map(newSkill => {
                const existingSkill = existingSkills.find(s => s.name === newSkill.name);
                if (existingSkill) {
                    return {
                        ...newSkill,
                        progress: existingSkill.progress,
                        lastPracticed: existingSkill.lastPracticed
                    };
                }
                return newSkill;
            });
            
            await redisSet(
                `skills:${userId}`,
                JSON.stringify(mergedSkills),
                'EX',
                SKILLS_CACHE_EXPIRATION
            );
            
            return true;
        } catch (error) {
            console.error('Error setting skills cache:', error);
            throw error;
        }
    },

    async updateSkillProgress(userId, skillName, progressDelta) {
        try {
            const skills = await this.getSkillProgress(userId) || [];
            const updatedSkills = skills.map(skill => {
                if (skill.name === skillName) {
                    const newProgress = Math.min(skill.progress + progressDelta, 100);
                    return {
                        ...skill,
                        progress: newProgress,
                        lastPracticed: new Date().toISOString()
                    };
                }
                return skill;
            });
            
            await this.setSkillProgress(userId, updatedSkills);
            return updatedSkills;
        } catch (error) {
            console.error('Error updating skill progress:', error);
            throw error;
        }
    },

    async invalidateSkillProgress(userId) {
        try {
            await redisDel(`skills:${userId}`);
            return true;
        } catch (error) {
            console.error('Error invalidating skills cache:', error);
            throw error;
        }
    },

    // Articles caching
    async getArticles(userId) {
        try {
            const cachedData = await redisGet(`articles:${userId}`);
            if (cachedData) {
                return JSON.parse(cachedData);
            }
            return null;
        } catch (error) {
            console.error('Error getting articles from cache:', error);
            throw error;
        }
    },

    async setArticles(userId, articles) {
        try {
            await redisSet(
                `articles:${userId}`,
                JSON.stringify(articles),
                'EX',
                ARTICLES_CACHE_EXPIRATION
            );
            return true;
        } catch (error) {
            console.error('Error setting articles cache:', error);
            throw error;
        }
    },

    async invalidateArticles(userId) {
        try {
            await redisDel(`articles:${userId}`);
            return true;
        } catch (error) {
            console.error('Error invalidating articles cache:', error);
            throw error;
        }
    },

    // Recommendations caching
    async getRecommendations(userId) {
        try {
            const cachedData = await redisGet(`recommendations:${userId}`);
            if (cachedData) {
                return JSON.parse(cachedData);
            }
            return null;
        } catch (error) {
            console.error('Error getting recommendations from cache:', error);
            throw error;
        }
    },

    async setRecommendations(userId, recommendations) {
        try {
            await redisSet(
                `recommendations:${userId}`,
                JSON.stringify(recommendations),
                'EX',
                RECOMMENDATIONS_CACHE_EXPIRATION
            );
            return true;
        } catch (error) {
            console.error('Error setting recommendations cache:', error);
            throw error;
        }
    },

    async invalidateRecommendations(userId) {
        try {
            await redisDel(`recommendations:${userId}`);
            return true;
        } catch (error) {
            console.error('Error invalidating recommendations cache:', error);
            throw error;
        }
    },

    // Combined operations
    async getUserData(userId) {
        try {
            const [dashboard, skills, articles, recommendations] = await Promise.all([
                this.getDashboard(userId),
                this.getSkillProgress(userId),
                this.getArticles(userId),
                this.getRecommendations(userId)
            ]);
            
            return {
                dashboard,
                skills,
                articles,
                recommendations
            };
        } catch (error) {
            console.error('Error getting combined user data:', error);
            throw error;
        }
    },

    async invalidateAllUserCaches(userId) {
        try {
            await Promise.all([
                this.invalidateDashboard(userId),
                this.invalidateSkillProgress(userId),
                this.invalidateArticles(userId),
                this.invalidateRecommendations(userId)
            ]);
            return true;
        } catch (error) {
            console.error('Error invalidating all user caches:', error);
            throw error;
        }
    },

    // Utility methods
    async getUserActivity(userId) {
        try {
            const lastActivity = await redisGet(`user:${userId}:last_activity`);
            return lastActivity || null;
        } catch (error) {
            console.error('Error getting user activity:', error);
            throw error;
        }
    },

    async getAllUserKeys() {
        try {
            const keys = await redisKeys('user:*');
            return keys;
        } catch (error) {
            console.error('Error getting all user keys:', error);
            throw error;
        }
    },

    // Close connection (for graceful shutdown)
    closeConnection() {
        client.quit();
    }
};