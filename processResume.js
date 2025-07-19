const fs = require('fs');
const path = require('path');
const axios = require('axios');
const natural = require('natural');
const { promisify } = require('util');
const readFile = promisify(fs.readFile);
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const { extractEntities } = require('./nerProcessor');
const { setDashboard, setSkillProgress } = require('./userDashboardCache');

const HUGGINGFACE_API_KEY = process.env.HUGGINGFACE_API_KEY;
const SENTIMENT_MODEL = process.env.SENTIMENT_MODEL || 'j-hartmann/emotion-english-distilroberta-base';
const SKILL_LEVEL_THRESHOLDS = {
    beginner: 30,
    intermediate: 60,
    advanced: 80,
    expert: 95
};

module.exports = async function processResume(filePath, fileType, userId) {
    try {
        // 1. Extract text from resume based on file type
        const resumeText = await extractTextFromFile(filePath, fileType);
        
        // 2. Analyze with multiple AI services in parallel
        const [sentimentAnalysis, entities, readability] = await Promise.all([
            analyzeSentiment(resumeText),
            extractEntities(resumeText),
            calculateReadability(resumeText)
        ]);
        
        // 3. Extract keywords and important phrases
        const keywords = extractKeywords(resumeText);
        const importantPhrases = extractImportantPhrases(resumeText);
        
        // 4. Calculate overall score
        const score = calculateScore(sentimentAnalysis, entities, readability, keywords.length);
        
        // 5. Identify strengths and improvements
        const strengths = findStrengths(entities, keywords, importantPhrases);
        const improvements = findImprovements(sentimentAnalysis, entities, readability);
        
        // 6. Generate skill assessment
        const skillAssessment = assessSkills(entities.skills);
        
        // 7. Update dashboard and skill progress in cache
        const dashboardData = {
            score: Math.round(score),
            strengths,
            improvements,
            keywords: keywords.slice(0, 20),
            importantPhrases: importantPhrases.slice(0, 10),
            sentiment: sentimentAnalysis,
            readability,
            entities,
            lastUpdated: new Date().toISOString()
        };
        
        await setDashboard(userId, dashboardData);
        await setSkillProgress(userId, skillAssessment);
        
        // 8. Return comprehensive analysis
        return {
            ...dashboardData,
            skillAssessment
        };
    } catch (error) {
        console.error('Resume processing failed:', error);
        return fallbackAnalysis();
    }
};

async function extractTextFromFile(filePath, fileType) {
    try {
        if (fileType === 'application/pdf') {
            const dataBuffer = await readFile(filePath);
            const data = await pdf(dataBuffer);
            return data.text;
        } else if (fileType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            const result = await mammoth.extractRawText({ path: filePath });
            return result.value;
        } else if (fileType === 'text/plain') {
            return readFile(filePath, 'utf8');
        }
        throw new Error('Unsupported file type');
    } catch (error) {
        console.error('Text extraction error:', error);
        throw error;
    }
}

async function analyzeSentiment(text) {
    try {
        const response = await axios.post(
            `https://api-inference.huggingface.co/models/${SENTIMENT_MODEL}`,
            { inputs: text },
            { 
                headers: { 
                    'Authorization': `Bearer ${HUGGINGFACE_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            }
        );
        
        // Process sentiment results
        const results = Array.isArray(response.data) ? response.data : [response.data];
        const primarySentiment = results[0] || { label: 'neutral', score: 1 };
        
        return {
            label: primarySentiment.label,
            score: primarySentiment.score,
            allResults: results
        };
    } catch (error) {
        console.error('Sentiment analysis failed:', error.message);
        return { label: 'neutral', score: 1, allResults: [] };
    }
}

function calculateReadability(text) {
    const tokenizer = new natural.SentenceTokenizer();
    const sentences = tokenizer.tokenize(text);
    const words = natural.WordTokenizer().tokenize(text);
    
    // Calculate various readability metrics
    const flesch = natural.FleschKincaidReability.textStatistics(text);
    
    return {
        sentenceCount: sentences.length,
        wordCount: words.length,
        avgSentenceLength: words.length / Math.max(sentences.length, 1),
        avgWordLength: words.join('').length / Math.max(words.length, 1),
        fleschScore: flesch.fleschKincaidReadability,
        fleschGradeLevel: flesch.fleschKincaidGradeLevel,
        difficultWords: flesch.difficultWords
    };
}

function extractKeywords(text) {
    const tokenizer = new natural.WordTokenizer();
    const words = tokenizer.tokenize(text.toLowerCase());
    const stopwords = new Set(natural.stopwords);
    
    // Filter out stopwords and short words
    const filteredWords = words.filter(word => 
        word.length > 3 && !stopwords.has(word) && !/\d/.test(word)
    );
    
    // Count word frequencies
    const wordFreq = {};
    filteredWords.forEach(word => {
        wordFreq[word] = (wordFreq[word] || 0) + 1;
    });
    
    // Sort by frequency and take top keywords
    return Object.entries(wordFreq)
        .sort((a, b) => b[1] - a[1])
        .map(entry => entry[0]);
}

function extractImportantPhrases(text) {
    const nounInflector = new natural.NounInflector();
    const tokenizer = new natural.WordTokenizer();
    const words = tokenizer.tokenize(text);
    const stopwords = new Set(natural.stopwords);
    
    // Extract noun phrases
    const posTagger = new natural.BrillPOSTagger(
        natural.baseline,
        natural.rules
    );
    
    const taggedWords = posTagger.tag(words);
    const phrases = [];
    let currentPhrase = [];
    
    taggedWords.forEach(([word, tag]) => {
        if (tag.startsWith('NN') && !stopwords.has(word.toLowerCase())) {
            currentPhrase.push(word);
        } else if (currentPhrase.length > 0) {
            phrases.push(currentPhrase.join(' '));
            currentPhrase = [];
        }
    });
    
    // Add any remaining phrase
    if (currentPhrase.length > 0) {
        phrases.push(currentPhrase.join(' '));
    }
    
    // Count phrase frequencies
    const phraseFreq = {};
    phrases.forEach(phrase => {
        phraseFreq[phrase] = (phraseFreq[phrase] || 0) + 1;
    });
    
    // Sort by frequency and return top phrases
    return Object.entries(phraseFreq)
        .sort((a, b) => b[1] - a[1])
        .map(entry => entry[0]);
}

function calculateScore(sentiment, entities, readability, keywordCount) {
    let score = 70; // Base score
    
    // Positive sentiment boosts score
    if (sentiment.label === 'joy' && sentiment.score > 0.7) score += 10;
    
    // Good readability boosts score
    if (readability.fleschScore > 60) score += 5;
    if (readability.avgSentenceLength < 20) score += 5;
    
    // More skills and entities boost score
    score += Math.min(entities.skills.length * 2, 20);
    score += Math.min(entities.companies.length * 1, 10);
    
    // More keywords boost score
    score += Math.min(keywordCount * 0.5, 10);
    
    return Math.min(Math.max(score, 0), 100);
}

function assessSkills(skills) {
    return skills.map(skill => {
        const level = calculateSkillLevel(skill);
        return {
            name: skill,
            level,
            targetLevel: level < 80 ? level + 20 : 100, // Aim for 20% improvement
            category: getSkillCategory(skill),
            lastPracticed: new Date().toISOString(),
            progress: 0
        };
    });
}

function calculateSkillLevel(skillName) {
    // This is a simplified version - in a real app you'd use more sophisticated analysis
    const baseLevel = Math.min(Math.floor(Math.random() * 30) + 50, 90); // Random between 50-80
    const bonus = skillName.length % 20; // Add some variation based on skill name
    return Math.min(baseLevel + bonus, 100);
}

function getSkillCategory(skillName) {
    const categories = {
        programming: ['javascript', 'python', 'java', 'c++', 'typescript', 'go', 'rust'],
        frontend: ['react', 'angular', 'vue', 'html', 'css', 'sass'],
        backend: ['node', 'express', 'django', 'flask', 'spring', 'laravel'],
        database: ['mysql', 'postgresql', 'mongodb', 'redis', 'sqlite'],
        devops: ['docker', 'kubernetes', 'aws', 'azure', 'gcp', 'terraform'],
        soft: ['communication', 'leadership', 'teamwork', 'problem solving']
    };
    
    const lowerSkill = skillName.toLowerCase();
    
    for (const [category, skills] of Object.entries(categories)) {
        if (skills.some(s => lowerSkill.includes(s))) {
            return category;
        }
    }
    
    return 'other';
}

function findStrengths(entities, keywords, phrases) {
    const strengths = [];
    
    if (entities.skills.length > 5) {
        strengths.push(`Strong technical skills (${entities.skills.length} skills identified)`);
    }
    
    if (entities.companies.length > 0) {
        strengths.push(`Professional experience at ${entities.companies.length} companies`);
    }
    
    if (entities.education.length > 0) {
        strengths.push(`Strong educational background (${entities.education.length} institutions)`);
    }
    
    if (keywords.length > 10) {
        strengths.push('Rich in relevant keywords');
    }
    
    if (phrases.length > 5) {
        strengths.push('Well-articulated professional experience');
    }
    
    return strengths.length > 0 ? strengths : ['Well-structured resume'];
}

function findImprovements(sentiment, entities, readability) {
    const improvements = [];
    
    if (sentiment.label === 'anger' || sentiment.label === 'sadness') {
        improvements.push('Consider more positive and professional language');
    }
    
    if (entities.skills.length < 3) {
        improvements.push('Add more technical skills to stand out');
    }
    
    if (entities.companies.length === 0) {
        improvements.push('Include company names for better credibility');
    }
    
    if (readability.avgSentenceLength > 25) {
        improvements.push('Shorten long sentences for better readability');
    }
    
    if (readability.fleschScore < 60) {
        improvements.push('Simplify language to make resume more accessible');
    }
    
    return improvements.length > 0 ? improvements : ['Minor formatting suggestions'];
}

function fallbackAnalysis() {
    return {
        score: 70,
        strengths: ['Basic structure is good'],
        improvements: ['Could not perform full analysis - try again later'],
        keywords: [],
        importantPhrases: [],
        sentiment: { label: 'neutral', score: 1, allResults: [] },
        readability: {
            sentenceCount: 0,
            wordCount: 0,
            avgSentenceLength: 0,
            avgWordLength: 0,
            fleschScore: 0,
            fleschGradeLevel: 0,
            difficultWords: 0
        },
        entities: {
            skills: [],
            companies: [],
            titles: [],
            education: []
        },
        skillAssessment: []
    };
}