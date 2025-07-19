require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { createBullBoard } = require('@bull-board/api');
const { BullAdapter } = require('@bull-board/api/bullAdapter');
const { ExpressAdapter } = require('@bull-board/express');
const Bull = require('bull');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const natural = require('natural');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');

// Import Redis client
const { redisClient, redisGet, redisSet, redisDel } = require('./redisClient');
const dashboardCache = require('./userDashboardCache');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// ======================
// Middleware Setup
// ======================
app.use(helmet());
app.use(cors({
    origin: ['http://localhost:3000', 'http://127.0.0.1:3000'],
    credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(morgan('dev'));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Too many requests from this IP, please try again later'
});
app.use('/api/', limiter);

// ======================
// Database Connections
// ======================
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/skillforgex', {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000
});

const db = mongoose.connection;
db.on('error', console.error.bind(console, 'MongoDB connection error:'));
db.on('connected', () => console.log('Connected to MongoDB'));
db.on('disconnected', () => console.log('Disconnected from MongoDB'));

// ======================
// Queue Setup
// ======================
const resumeQueue = new Bull('resume-queue', {
    redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379
    },
    limiter: {
        max: 5,
        duration: 1000
    }
});

const articleQueue = new Bull('article-queue', {
    redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379
    }
});

// Bull board setup for queue monitoring
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

createBullBoard({
    queues: [
        new BullAdapter(resumeQueue),
        new BullAdapter(articleQueue)
    ],
    serverAdapter: serverAdapter
});

app.use('/admin/queues', serverAdapter.getRouter());

// ======================
// Data Models
// ======================
const userSchema = new mongoose.Schema({
    email: { 
        type: String, 
        required: true, 
        unique: true,
        validate: {
            validator: function(v) {
                return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
            },
            message: props => `${props.value} is not a valid email address!`
        }
    },
    password: { 
        type: String, 
        required: true,
        minlength: 8
    },
    role: { 
        type: String, 
        enum: ['user', 'admin'], 
        default: 'user' 
    },
    skills: [{
        name: { 
            type: String, 
            required: true,
            maxlength: 50
        },
        level: { 
            type: Number, 
            min: 0, 
            max: 100,
            default: 0
        },
        targetLevel: { 
            type: Number, 
            min: 0, 
            max: 100,
            default: 50
        },
        lastPracticed: Date
    }],
    resumeAnalysis: {
        score: { 
            type: Number, 
            min: 0, 
            max: 100 
        },
        strengths: [{
            type: String,
            maxlength: 100
        }],
        improvements: [{
            type: String,
            maxlength: 100
        }],
        entities: {
            skills: [String],
            companies: [String],
            titles: [String],
            education: [String]
        },
        lastAnalyzed: Date
    },
    learningGoals: [{
        title: {
            type: String,
            required: true,
            maxlength: 100
        },
        description: {
            type: String,
            maxlength: 200
        },
        targetDate: Date,
        completed: {
            type: Boolean,
            default: false
        }
    }],
    createdAt: {
        type: Date,
        default: Date.now
    }
});

// Indexes for better query performance
userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ 'skills.name': 1 });
userSchema.index({ createdAt: 1 });

const User = mongoose.model('User', userSchema);

const resumeAnalysisSchema = new mongoose.Schema({
    userId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'User',
        index: true
    },
    originalFilename: String,
    storedFilename: String,
    fileType: String,
    fileSize: Number,
    analysisResult: {
        score: Number,
        strengths: [String],
        improvements: [String],
        keywords: [String],
        sentiment: Object,
        readability: Object,
        entities: Object
    },
    createdAt: { 
        type: Date, 
        default: Date.now,
        index: true
    }
});

const ResumeAnalysis = mongoose.model('ResumeAnalysis', resumeAnalysisSchema);

// ======================
// File Upload Setup
// ======================
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const fileFilter = (req, file, cb) => {
    const allowedTypes = [
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'text/plain'
    ];
    
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type. Only PDF, DOCX, and TXT files are allowed.'), false);
    }
};

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `${uuidv4()}${ext}`);
    }
});

const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: { 
        fileSize: parseInt(process.env.FILE_UPLOAD_LIMIT || '5') * 1024 * 1024 
    }
});

// ======================
// Utility Functions
// ======================
async function extractTextFromFile(filePath, fileType) {
    try {
        if (fileType === 'application/pdf') {
            const dataBuffer = fs.readFileSync(filePath);
            const data = await pdf(dataBuffer);
            return data.text;
        } else if (fileType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            const result = await mammoth.extractRawText({ path: filePath });
            return result.value;
        } else if (fileType === 'text/plain') {
            return fs.readFileSync(filePath, 'utf8');
        }
        throw new Error('Unsupported file type');
    } catch (error) {
        console.error('Text extraction error:', error);
        throw error;
    }
}

async function analyzeResumeWithAI(resumeText) {
    try {
        // Mock analysis implementation
        return {
            score: 85,
            strengths: ['Strong technical skills', 'Good work experience'],
            improvements: ['Add more metrics', 'Include more soft skills'],
            keywords: ['javascript', 'nodejs', 'mongodb'],
            sentiment: { label: 'positive', score: 0.95 },
            readability: {
                sentenceCount: 42,
                wordCount: 350,
                avgSentenceLength: 8.3,
                fleschScore: 72
            },
            entities: {
                skills: ['JavaScript', 'Node.js', 'MongoDB'],
                companies: ['Tech Corp', 'Dev Solutions'],
                titles: ['Senior Developer', 'Team Lead'],
                education: ['Computer Science Degree']
            }
        };
    } catch (error) {
        console.error('AI analysis failed:', error);
        return fallbackAnalysis(resumeText);
    }
}

function fallbackAnalysis(text) {
    return {
        score: 70,
        strengths: ['Basic technical skills detected'],
        improvements: ['Could not perform full analysis'],
        keywords: ['javascript', 'html', 'css'],
        sentiment: { neutral: 1 },
        readability: {
            sentenceCount: 0,
            wordCount: 0,
            avgSentenceLength: 0,
            fleschScore: 0
        },
        entities: {
            skills: ['JavaScript', 'HTML', 'CSS'],
            companies: [],
            titles: [],
            education: []
        }
    };
}

// ======================
// Middlewares
// ======================
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ error: 'Authentication token required' });
    }

    jwt.verify(token, process.env.JWT_SECRET || 'default_secret', (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid or expired token' });
        }
        req.user = user;
        next();
    });
}

// ======================
// Routes
// ======================

// Health Check Endpoint
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK',
        db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        redis: redisClient.isReady ? 'connected' : 'disconnected',
        uptime: process.uptime()
    });
});

// Resume Upload Endpoint
app.post('/api/upload-resume', upload.single('resume'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const job = await resumeQueue.add({
            userId: req.body.userId || 'anonymous',
            filePath: req.file.path,
            originalFilename: req.file.originalname,
            fileType: req.file.mimetype
        });

        res.json({ 
            message: 'Resume uploaded and analysis started',
            jobId: job.id,
            filename: req.file.originalname
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Failed to upload resume' });
    }
});

// Get Resume Analysis Results
app.get('/api/resume-analysis/:jobId', async (req, res) => {
    try {
        const jobId = req.params.jobId;
        const result = await redisGet(`resume:${jobId}`);
        
        if (!result) {
            return res.status(404).json({ error: 'Analysis not found' });
        }

        res.json(JSON.parse(result));
    } catch (error) {
        console.error('Analysis fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch analysis' });
    }
});

// Authentication Routes
app.post('/api/register', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }
        
        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }

        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ error: 'User already exists' });
        }

        const user = new User({ email, password });
        await user.save();

        const token = jwt.sign(
            { userId: user._id, email: user.email, role: user.role },
            process.env.JWT_SECRET || 'default_secret',
            { expiresIn: '1h' }
        );

        res.status(201).json({ 
            token,
            user: {
                id: user._id,
                email: user.email,
                role: user.role
            }
        });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ======================
// Queue Processors
// ======================
resumeQueue.process(5, async (job) => {
    const { userId, filePath, originalFilename, fileType } = job.data;
    
    try {
        const resumeText = await extractTextFromFile(filePath, fileType);
        const analysisResult = await analyzeResumeWithAI(resumeText);

        const resumeAnalysis = new ResumeAnalysis({
            userId,
            originalFilename,
            storedFilename: path.basename(filePath),
            fileType,
            fileSize: fs.statSync(filePath).size,
            analysisResult
        });
        
        await resumeAnalysis.save();

        await User.findByIdAndUpdate(userId, {
            $set: {
                'resumeAnalysis.score': analysisResult.score,
                'resumeAnalysis.strengths': analysisResult.strengths,
                'resumeAnalysis.improvements': analysisResult.improvements,
                'resumeAnalysis.entities': analysisResult.entities,
                'resumeAnalysis.lastAnalyzed': new Date()
            }
        });

        await redisSet(`resume:${userId}:${job.id}`, JSON.stringify({
            status: 'completed',
            result: analysisResult,
            timestamp: new Date().toISOString()
        }));

        await dashboardCache.invalidateAllUserCaches(userId);

        return analysisResult;
    } catch (error) {
        console.error('Resume processing error:', error);
        await redisSet(`resume:${userId}:${job.id}`, JSON.stringify({
            status: 'failed',
            error: error.message,
            timestamp: new Date().toISOString()
        }));
        throw error;
    } finally {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    }
});

// ======================
// Server Startup
// ======================
function scheduleJobs() {
    // Daily article updates
    articleQueue.add({}, { 
        repeat: { cron: '0 3 * * *' },
        attempts: 3,
        backoff: {
            type: 'exponential',
            delay: 5000
        }
    });
    
    // Weekly summaries
    resumeQueue.add({ type: 'weekly-summary' }, { 
        repeat: { cron: '0 9 * * 1' },
        attempts: 3
    });
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down gracefully...');
    
    try {
        await mongoose.connection.close();
        await redisClient.quit();
        await resumeQueue.close();
        await articleQueue.close();
        process.exit(0);
    } catch (err) {
        console.error('Error during shutdown:', err);
        process.exit(1);
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    scheduleJobs();
});