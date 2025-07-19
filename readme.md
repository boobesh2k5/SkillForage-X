Project Name : SkillForgeX: AI-Powered Skill Tracker & Resume Optimization System
Submitted by: M Boobeshwaran
Date: 14-07-2025

🚀 Project Overview
SkillForageX is a full-stack developer toolkit featuring Bootstrap-powered UI, secure API integrations, and Redis caching. This Node.js application combines modern frontend design with robust backend processing.

🛠️ Setup Instructions
1. Environment Configuration
Create .env file with:

# API Credentials
HUGGINGFACE_API_KE=your_ai_api_model_key
GITHUB_OAUTH_KEY=your_github_key
REDIS_URL=redis://127.0.0.1:6379

# App Config
PORT=3000
SESSION_SECRET=your_secret_here
RATE_LIMIT=100req/hour

2. Installation

npm install  # Installs both frontend & backend dependencies

3. Run Development Server
bash
node server.js  # Starts on http://localhost:3000
🌟 Enhanced Feature Set
Frontend (Bootstrap 5)
✅ Responsive Dashboard
✅ Interactive Job Cards
✅ Animated Toast Notifications
✅ Custom Theme Colors

Backend Services
🔌 API Integrations

HUGGINGFACE_API
MONGOOSE DB API 


GitHub Jobs API

Dev.to Blog API

⚡ Performance

Redis caching (userDashboardCache.js)

Network optimization (netProcessor.js)

🗂️ Updated Project Structure

📁 SkillForageX
├── 📂 public/            # Bootstrap frontend
│   ├── css/style.css     # Custom Bootstrap overrides
│   └── js/main.js        # Frontend logic
│
├── 📜 server.js          # Express server (API routes)
├── 📜 fetchDevBlogs.js   # Dev.to API integration
├── 📜 processResume.js   # Resume parser API
├── 📜 package.json       # Includes Bootstrap deps
└── 📜 .env               # All API keys

📦 Key Dependencies

Frontend

json
"dependencies": {
  "bootstrap": "^5.3.0",
  "@popperjs/core": "^2.11.8"
}
Backend

json
"dependencies": {
  "axios": "^1.5.0",          # API calls
  "express-rate-limit": "^6.7",# API throttling
  "redis": "^4.6.5",          # Caching
  "dotenv": "^16.3.1"         # .env management
}

🌐 API Usage Example
javascript
// fetchDevBlogs.js
const fetchArticles = async () => {
  const response = await axios.get('https://dev.to/api/articles', {
    headers: {
      'api-key': process.env.DEVTO_API_KEY,
      'RateLimit-Limit': 50 // API throttling
    }
  });
  return response.data;
};

📌 Changelogs

New: Bootstrap 5 UI components

Improved: API error handling

Fixed: .env variable loading

Optimized: Redis cache TTL

Key Additions:

Clear API Documentation - Shows JSearch/GitHub API usage

Bootstrap Integration - Frontend framework highlighted

Environment Variables - Proper .env structure

Rate Limiting - API call protection

Redis Caching - With TTL optimization

© 2025 M. Boobeshwaran | Cognifyz Technologies