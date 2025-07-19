const axios = require('axios');
const natural = require('natural');
const { promisify } = require('util');
const redis = require('redis');
const { createClient } = redis;

// Initialize Redis client
const redisClient = createClient({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379
});

redisClient.on('error', (err) => console.error('Redis error:', err));
redisClient.on('connect', () => console.log('Connected to Redis'));

const redisGet = promisify(redisClient.get).bind(redisClient);
const redisSet = promisify(redisClient.set).bind(redisClient);
const redisDel = promisify(redisClient.del).bind(redisClient);

const NER_MODEL = process.env.NER_MODEL || 'dslim/bert-base-NER';
const CACHE_EXPIRATION = 86400; // 24 hours

async function extractEntities(resumeText) {
    try {
        if (!resumeText || typeof resumeText !== 'string' || resumeText.trim() === '') {
            throw new Error('Invalid resume text provided');
        }

        // Check cache first
        const cacheKey = `ner:${hashText(resumeText)}`;
        const cached = await redisGet(cacheKey);
        
        if (cached) {
            try {
                return JSON.parse(cached);
            } catch (parseError) {
                console.error('Error parsing cached data:', parseError);
                await redisDel(cacheKey);
            }
        }
        
        // Call Hugging Face API if not in cache
        const response = await axios.post(
            `https://api-inference.huggingface.co/models/${NER_MODEL}`,
            { inputs: resumeText },
            { 
                headers: { 
                    'Authorization': `Bearer ${process.env.HUGGINGFACE_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            }
        );
        
        if (!response.data) {
            throw new Error('No data received from Hugging Face API');
        }

        const entities = processNERResults(response.data);
        
        // Cache the results
        try {
            await redisSet(
                cacheKey,
                JSON.stringify(entities),
                'EX',
                CACHE_EXPIRATION
            );
        } catch (cacheError) {
            console.error('Redis cache error:', cacheError);
        }
        
        return entities;
    } catch (error) {
        console.error('NER Error:', error.response?.data || error.message);
        return fallbackEntityExtraction(resumeText);
    }
}

function processNERResults(entities) {
    const result = { 
        skills: [], 
        companies: [], 
        titles: [], 
        education: [],
        certifications: []
    };
    
    if (!Array.isArray(entities)) {
        return result;
    }

    entities.forEach(entity => {
        if (!entity || !entity.word || !entity.entity) return;

        const text = cleanEntityText(entity.word);
        if (!text) return;

        switch(entity.entity) {
            case 'B-TECH': 
            case 'I-TECH':
                if (text.length > 1) result.skills.push(text);
                break;
                
            case 'B-ORG': 
            case 'I-ORG':
                if (isEducationalInstitution(text)) {
                    result.education.push(text);
                } else {
                    result.companies.push(text);
                }
                break;
                
            case 'B-PER': 
            case 'I-PER':
                if (isLikelyTitle(text)) {
                    result.titles.push(text);
                }
                break;
                
            case 'B-EDU': 
            case 'I-EDU':
                result.education.push(text);
                break;
                
            case 'B-CERT': 
            case 'I-CERT':
                result.certifications.push(text);
                break;
        }
    });
    
    // Deduplicate and clean results
    Object.keys(result).forEach(key => {
        result[key] = [...new Set(result[key]
            .filter(item => item && typeof item === 'string')
            .map(cleanEntityText)
            .filter(text => text.length > 1)
        )];
    });
    
    return result;
}

function cleanEntityText(text) {
    if (!text || typeof text !== 'string') return '';
    return text
        .replace(/^##/, '') // Remove BERT subword markers
        .replace(/[^\w\s-]/g, '') // Remove special chars except hyphen and space
        .trim();
}

function isEducationalInstitution(text) {
    if (!text) return false;
    const eduKeywords = ['university', 'college', 'institute', 'school', 'academy'];
    return eduKeywords.some(keyword => 
        text.toLowerCase().includes(keyword)
    );
}

function isLikelyTitle(text) {
    if (!text) return false;
    const titleKeywords = ['engineer', 'developer', 'manager', 'director', 'specialist'];
    return titleKeywords.some(keyword => 
        text.toLowerCase().includes(keyword)
    );
}

function fallbackEntityExtraction(text) {
    if (!text || typeof text !== 'string') {
        return {
            skills: [],
            companies: [],
            titles: [],
            education: [],
            certifications: []
        };
    }

    // Simple regex fallback when API fails
    const techKeywords = ['javascript', 'react', 'node', 'python', 'java', 'html', 'css'];
    const companies = extractByPattern(text, /at\s+([A-Z][a-zA-Z]+)/g);
    const education = extractByPattern(text, /(university|college)\s+of\s+([A-Z][a-zA-Z]+)/gi);
    
    return {
        skills: techKeywords.filter(skill => 
            text.toLowerCase().includes(skill)),
        companies: companies,
        titles: [],
        education: education,
        certifications: []
    };
}

function extractByPattern(text, pattern) {
    const matches = [];
    let match;
    try {
        while ((match = pattern.exec(text)) !== null) {
            if (match[1] || match[0]) {
                matches.push((match[1] || match[0]).trim());
            }
        }
    } catch (e) {
        console.error('Pattern extraction error:', e);
    }
    return [...new Set(matches.filter(m => m))];
}

function hashText(text) {
    if (!text) return 'empty';
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        const char = text.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0; // Convert to 32bit integer
    }
    return hash.toString(16);
}

// Connect to Redis when module loads
(async () => {
    try {
        await redisClient.connect();
    } catch (err) {
        console.error('Redis connection error:', err);
    }
})();

module.exports = { 
    extractEntities,
    redisClient
};