const axios = require('axios');
const { extractEntities } = require('./nerProcessor');
const { processResume } = require('./processResume');

// Configuration
const API_TOKEN = process.env.HUGGINGFACE_API_KEY;
const TEST_RESUME_PATH = './test_resume.pdf';
const TEST_TEXT = "Experienced JavaScript developer with 5 years of experience in React and Node.js. Worked at Google and Amazon. Master's degree in Computer Science from Stanford.";

// Test counters
let apiCalls = 0;
let testsPassed = 0;
let testsFailed = 0;

// Utility functions
function logTestResult(testName, passed, error = null) {
    if (passed) {
        console.log(`✓ ${testName} - Passed`);
        testsPassed++;
    } else {
        console.error(`✗ ${testName} - Failed`, error || '');
        testsFailed++;
    }
}

async function testSentimentAnalysis() {
    try {
        apiCalls++;
        const response = await axios.post(
            'https://api-inference.huggingface.co/models/j-hartmann/emotion-english-distilroberta-base',
            { inputs: "I love programming with JavaScript!" },
            { headers: { "Authorization": `Bearer ${API_TOKEN}` } }
        );
        
        const result = response.data[0];
        const passed = result && result.label && result.score;
        logTestResult('Sentiment Analysis', passed);
    } catch (error) {
        logTestResult('Sentiment Analysis', false, error.message);
    }
}

async function testEntityExtraction() {
    try {
        apiCalls++;
        const entities = await extractEntities(TEST_TEXT);
        const passed = entities && 
                      entities.skills.includes('JavaScript') && 
                      entities.companies.includes('Google');
        logTestResult('Entity Extraction', passed);
    } catch (error) {
        logTestResult('Entity Extraction', false, error.message);
    }
}

async function testResumeProcessing() {
    try {
        // Mock file processing since we don't have actual file in test
        const result = await processResume(TEST_RESUME_PATH, 'application/pdf', 'test-user');
        const passed = result && 
                      typeof result.score === 'number' && 
                      Array.isArray(result.keywords);
        logTestResult('Resume Processing', passed);
    } catch (error) {
        logTestResult('Resume Processing', false, error.message);
    }
}

async function testCacheFunctionality() {
    try {
        const cache = require('./userDashboardCache');
        const testData = { test: 'data' };
        
        await cache.setDashboard('test-user', testData);
        const retrieved = await cache.getDashboard('test-user');
        
        const passed = retrieved && retrieved.test === 'data';
        logTestResult('Cache Functionality', passed);
        
        await cache.invalidateDashboard('test-user');
    } catch (error) {
        logTestResult('Cache Functionality', false, error.message);
    }
}

async function runAllTests() {
    console.log('Starting SkillForgeX API tests...\n');
    
    await testSentimentAnalysis();
    await testEntityExtraction();
    await testResumeProcessing();
    await testCacheFunctionality();
    
    console.log('\nTest Summary:');
    console.log(`Total Tests: ${testsPassed + testsFailed}`);
    console.log(`Passed: ${testsPassed}`);
    console.log(`Failed: ${testsFailed}`);
    console.log(`API Calls Made: ${apiCalls}/30,000 (monthly free limit)`);
    
    if (testsFailed > 0) {
        process.exit(1);
    }
}

runAllTests().catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
});