const axios = require('axios');
const { redisGet, redisSet } = require('./userDashboardCache');
const { getSkillProgress } = require('./userDashboardCache');

const MAX_ARTICLES_PER_SKILL = 3;
const CACHE_EXPIRATION = 21600; // 6 hours
const MIN_READING_TIME = 3; // minutes
const MAX_READING_TIME = 30; // minutes

// Sources configuration
const SOURCES = [
    {
        name: 'DEV Community',
        apiUrl: 'https://dev.to/api/articles',
        params: {
            per_page: MAX_ARTICLES_PER_SKILL * 2,
            top: 7
        },
        transform: article => ({
            title: article.title,
            url: article.url,
            description: article.description || 'No description available',
            tag: article.tag_list[0] || 'general',
            image: article.cover_image || getDefaultImage(article.tag_list[0]),
            publishedAt: article.published_at,
            readingTime: article.reading_time_minutes,
            source: 'DEV Community'
        }),
        filter: article => 
            article.title && 
            article.url && 
            !article.title.toLowerCase().includes('sponsor') &&
            article.reading_time_minutes >= MIN_READING_TIME &&
            article.reading_time_minutes <= MAX_READING_TIME
    },
    {
        name: 'Hashnode',
        apiUrl: 'https://api.hashnode.com',
        query: `query GetArticles($tag: String!) {
            storiesFeed(type: FEATURED, tag: $tag) {
                title
                brief
                slug
                coverImage
                dateAdded
                readTime
                tags {
                    name
                }
            }
        }`,
        transform: article => ({
            title: article.title,
            url: `https://hashnode.com/post/${article.slug}`,
            description: article.brief || 'No description available',
            tag: article.tags[0]?.name || 'general',
            image: article.coverImage || getDefaultImage(article.tags[0]?.name),
            publishedAt: article.dateAdded,
            readingTime: article.readTime,
            source: 'Hashnode'
        }),
        filter: article => 
            article.title && 
            article.slug &&
            article.readTime >= MIN_READING_TIME &&
            article.readTime <= MAX_READING_TIME
    }
];

async function fetchDevBlogs(userId, skills) {
    try {
        // Get user's skill progress to prioritize skills with largest gaps
        const userSkills = await getSkillProgress(userId) || skills || [];
        
        // Sort skills by importance (gap between current and target level)
        const prioritizedSkills = userSkills
            .map(skill => ({
                name: skill.name.toLowerCase(),
                gap: (skill.targetLevel || 50) - (skill.level || 0),
                category: skill.category || 'other'
            }))
            .filter(skill => skill.gap > 0)
            .sort((a, b) => b.gap - a.gap)
            .slice(0, 5); // Top 5 skills with largest gaps
        
        if (prioritizedSkills.length === 0) {
            return [];
        }
        
        // Check cache first for each skill
        const cachedArticles = await Promise.all(
            prioritizedSkills.map(skill => 
                redisGet(`articles:${userId}:${skill.name}`)
                    .then(data => data ? JSON.parse(data) : null)
            )
        );
        
        // Determine which skills need fresh articles
        const skillsToFetch = prioritizedSkills.filter((skill, index) => 
            !cachedArticles[index]
        );
        
        // Fetch fresh articles for skills not in cache
        const freshArticles = await Promise.all(
            skillsToFetch.map(skill => 
                fetchArticlesForSkill(skill.name)
                    .then(articles => ({
                        skill: skill.name,
                        category: skill.category,
                        articles: articles.slice(0, MAX_ARTICLES_PER_SKILL)
                    }))
            )
        );
        
        // Cache the fresh articles
        await Promise.all(
            freshArticles.map(({skill, articles}) => 
                redisSet(
                    `articles:${userId}:${skill}`,
                    JSON.stringify(articles),
                    'EX',
                    CACHE_EXPIRATION
                )
            )
        );
        
        // Combine cached and fresh articles
        const allArticles = [];
        
        prioritizedSkills.forEach((skill, index) => {
            const articles = cachedArticles[index] || 
                freshArticles.find(f => f.skill === skill.name)?.articles || [];
            
            allArticles.push(...articles.map(article => ({
                ...article,
                relevance: calculateRelevance(skill, article),
                skill: skill.name,
                category: skill.category
            })));
        });
        
        // Sort articles by relevance and return top 6
        return allArticles
            .sort((a, b) => b.relevance - a.relevance)
            .slice(0, 6)
            .map(article => ({
                title: article.title,
                url: article.url,
                description: article.description,
                tag: article.tag,
                image: article.image,
                publishedAt: article.publishedAt,
                readingTime: article.readingTime,
                source: article.source,
                skill: article.skill,
                category: article.category,
                relevance: article.relevance.toFixed(2)
            }));
    } catch (error) {
        console.error('Error fetching dev blogs:', error);
        return [];
    }
}

function calculateRelevance(skill, article) {
    // Base relevance is the skill gap (0-1)
    let relevance = skill.gap / 100;
    
    // Boost if article tag matches skill exactly
    if (article.tag.toLowerCase() === skill.name.toLowerCase()) {
        relevance += 0.3;
    }
    
    // Boost for recent articles (within last week)
    const publishedDate = new Date(article.publishedAt);
    const daysOld = (Date.now() - publishedDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysOld < 7) {
        relevance += 0.2;
    }
    
    // Boost for optimal reading time (5-15 minutes)
    if (article.readingTime >= 5 && article.readingTime <= 15) {
        relevance += 0.1;
    }
    
    return Math.min(relevance, 1); // Cap at 1
}

async function fetchArticlesForSkill(skill) {
    try {
        // Fetch from all sources in parallel
        const results = await Promise.all(
            SOURCES.map(source => fetchFromSource(source, skill))
        );
        
        // Combine and deduplicate articles
        const allArticles = results.flat();
        const uniqueArticles = deduplicateArticles(allArticles);
        
        return uniqueArticles;
    } catch (error) {
        console.error(`Error fetching articles for ${skill}:`, error.message);
        return [];
    }
}

async function fetchFromSource(source, skill) {
    try {
        let response;
        
        if (source.apiUrl.includes('dev.to')) {
            // DEV Community API
            response = await axios.get(source.apiUrl, {
                params: {
                    ...source.params,
                    tag: skill
                },
                timeout: 10000
            });
            
            return response.data
                .filter(source.filter)
                .map(source.transform);
        } else if (source.apiUrl.includes('hashnode')) {
            // Hashnode GraphQL API
            response = await axios.post(source.apiUrl, {
                query: source.query,
                variables: { tag: skill }
            }, {
                timeout: 10000
            });
            
            return response.data.data.storiesFeed
                .filter(source.filter)
                .map(source.transform);
        }
        
        return [];
    } catch (error) {
        console.error(`Error fetching from ${source.name}:`, error.message);
        return [];
    }
}

function deduplicateArticles(articles) {
    const uniqueUrls = new Set();
    return articles.filter(article => {
        if (uniqueUrls.has(article.url)) {
            return false;
        }
        uniqueUrls.add(article.url);
        return true;
    });
}

function getDefaultImage(tag) {
    const colors = ['6c63ff', '4d44db', 'ff6584', '28a745', '17a2b8'];
    const color = colors[(tag || '').length % colors.length];
    const tagText = tag ? encodeURIComponent(tag.substring(0, 20)) : 'article';
    return `https://via.placeholder.com/600x400/${color}/ffffff?text=${tagText}`;
}

module.exports = { 
    fetchDevBlogs,
    SOURCES // Exported for testing
};