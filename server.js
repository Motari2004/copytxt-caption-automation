/**
 * Copytext Caption Automation Service
 * Deploy on Render
 */

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { getCaptionFromCopytext, processBatch } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3000;

// ============== DATABASE CONNECTION ==============

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// ============== AUTO CREATE TABLES ==============
// 🔥 This runs automatically when the server starts

async function initDatabase() {
    try {
        console.log('📦 Initializing database...');
        
        // Create captions table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS captions (
                id SERIAL PRIMARY KEY,
                url TEXT NOT NULL UNIQUE,
                caption TEXT,
                username TEXT,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            )
        `);
        console.log('✅ Table "captions" ready');

        // Create indexes
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_captions_url ON captions(url)
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_captions_username ON captions(username)
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_captions_created_at ON captions(created_at DESC)
        `);
        console.log('✅ Indexes ready');

        console.log('✅ Database initialized successfully');
    } catch (error) {
        console.error('❌ Database initialization error:', error.message);
    }
}

// Run database initialization
initDatabase();

// ============== DATABASE FUNCTIONS ==============

async function storeCaption(url, caption, username = null) {
    try {
        const query = `
            INSERT INTO captions (url, caption, username, created_at, updated_at)
            VALUES ($1, $2, $3, NOW(), NOW())
            ON CONFLICT (url) 
            DO UPDATE SET 
                caption = EXCLUDED.caption,
                username = COALESCE(EXCLUDED.username, captions.username),
                updated_at = NOW()
            RETURNING id
        `;
        
        const result = await pool.query(query, [url, caption, username]);
        console.log(`✅ Stored caption in database for: ${url.substring(0, 50)}...`);
        return result.rows[0]?.id;
    } catch (error) {
        console.error(`❌ Failed to store caption: ${error.message}`);
        return null;
    }
}

async function getCaptionFromDB(url) {
    try {
        const query = `
            SELECT caption, username, created_at 
            FROM captions 
            WHERE url = $1 
            ORDER BY created_at DESC 
            LIMIT 1
        `;
        
        const result = await pool.query(query, [url]);
        if (result.rows.length > 0) {
            console.log(`📦 Found caption in database: ${url.substring(0, 50)}...`);
            return result.rows[0];
        }
        return null;
    } catch (error) {
        console.error(`❌ Database query error: ${error.message}`);
        return null;
    }
}

async function getAllCaptions(limit = 100) {
    try {
        const query = `
            SELECT url, caption, username, created_at, updated_at
            FROM captions
            ORDER BY created_at DESC
            LIMIT $1
        `;
        const result = await pool.query(query, [limit]);
        return result.rows;
    } catch (error) {
        console.error(`❌ Database query error: ${error.message}`);
        return [];
    }
}

async function getCaptionsByUsername(username, limit = 50) {
    try {
        const query = `
            SELECT url, caption, created_at
            FROM captions
            WHERE username = $1
            ORDER BY created_at DESC
            LIMIT $2
        `;
        const result = await pool.query(query, [username, limit]);
        return result.rows;
    } catch (error) {
        console.error(`❌ Database query error: ${error.message}`);
        return [];
    }
}

// ============== MIDDLEWARE ==============

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ============== ROUTES ==============

/**
 * Health check endpoint
 */
app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT NOW()');
        res.json({
            status: 'healthy',
            service: 'Copytext Caption Automation',
            version: '1.0.0',
            uptime: process.uptime(),
            database: 'connected'
        });
    } catch (err) {
        res.json({
            status: 'healthy',
            service: 'Copytext Caption Automation',
            version: '1.0.0',
            uptime: process.uptime(),
            database: 'disconnected'
        });
    }
});

/**
 * Get caption for a single URL
 * POST /api/caption
 * Body: { "url": "https://www.instagram.com/...", "username": "optional" }
 */
app.post('/api/caption', async (req, res) => {
    const { url, username } = req.body;
    
    if (!url) {
        return res.status(400).json({ 
            error: 'Missing url parameter',
            message: 'Please provide an Instagram URL'
        });
    }
    
    try {
        // Check database first
        const dbResult = await getCaptionFromDB(url);
        
        if (dbResult && dbResult.caption) {
            return res.json({
                success: true,
                url: url,
                caption: dbResult.caption,
                length: dbResult.caption.length,
                source: 'database',
                timestamp: new Date().toISOString()
            });
        }
        
        console.log(`📝 Processing URL: ${url}`);
        const result = await getCaptionFromCopytext(url);
        
        if (result.success) {
            // Store in database
            await storeCaption(url, result.caption, username);
            
            res.json({
                success: true,
                url: result.url,
                caption: result.caption,
                length: result.caption.length,
                source: 'scraped',
                timestamp: new Date().toISOString()
            });
        } else {
            res.status(404).json({
                success: false,
                url: result.url,
                error: 'Could not extract caption',
                message: result.error || 'No caption found'
            });
        }
    } catch (error) {
        console.error(`❌ Error: ${error.message}`);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: error.message
        });
    }
});

/**
 * Process multiple URLs
 * POST /api/caption/batch
 * Body: { "urls": ["url1", "url2", ...] }
 */
app.post('/api/caption/batch', async (req, res) => {
    const { urls } = req.body;
    
    if (!urls || !Array.isArray(urls) || urls.length === 0) {
        return res.status(400).json({
            error: 'Invalid urls parameter',
            message: 'Please provide an array of Instagram URLs'
        });
    }
    
    try {
        console.log(`📋 Processing ${urls.length} URLs...`);
        
        // Check database for each URL
        const results = [];
        const urlsToScrape = [];
        
        for (const url of urls) {
            const dbResult = await getCaptionFromDB(url);
            if (dbResult && dbResult.caption) {
                results.push({
                    url: url,
                    caption: dbResult.caption,
                    success: true,
                    source: 'database',
                    timestamp: new Date().toISOString()
                });
            } else {
                urlsToScrape.push(url);
            }
        }
        
        // Scrape remaining URLs
        if (urlsToScrape.length > 0) {
            console.log(`📝 Scraping ${urlsToScrape.length} URLs...`);
            const scrapedResults = await processBatch(urlsToScrape);
            
            // Store scraped results in database
            for (const result of scrapedResults) {
                if (result.success && result.caption) {
                    await storeCaption(result.url, result.caption);
                }
                results.push(result);
            }
        }
        
        const withCaptions = results.filter(r => r.success && r.caption);
        
        res.json({
            success: true,
            total: results.length,
            withCaptions: withCaptions.length,
            withoutCaptions: results.length - withCaptions.length,
            results: results,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error(`❌ Error: ${error.message}`);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: error.message
        });
    }
});

/**
 * Get caption from Instagram URL via oEmbed (direct method)
 * GET /api/caption?url=https://www.instagram.com/...
 */
app.get('/api/caption', async (req, res) => {
    const { url } = req.query;
    
    if (!url) {
        return res.status(400).json({
            error: 'Missing url parameter',
            message: 'Please provide an Instagram URL'
        });
    }
    
    try {
        // Check database first
        const dbResult = await getCaptionFromDB(url);
        
        if (dbResult && dbResult.caption) {
            return res.json({
                success: true,
                url: url,
                caption: dbResult.caption,
                length: dbResult.caption.length,
                source: 'database',
                timestamp: new Date().toISOString()
            });
        }
        
        // Try oEmbed first as a faster alternative
        const axios = require('axios');
        const oembedUrl = `https://api.instagram.com/oembed?url=${encodeURIComponent(url)}`;
        const response = await axios.get(oembedUrl, { timeout: 10000 });
        
        if (response.data && response.data.title) {
            // Store in database
            await storeCaption(url, response.data.title);
            
            res.json({
                success: true,
                url: url,
                caption: response.data.title,
                author: response.data.author_name || '',
                method: 'oembed',
                timestamp: new Date().toISOString()
            });
        } else {
            // Fallback to copytext automation
            const result = await getCaptionFromCopytext(url);
            
            if (result.success) {
                await storeCaption(url, result.caption);
            }
            res.json(result);
        }
    } catch (error) {
        // Fallback to copytext automation
        try {
            const result = await getCaptionFromCopytext(url);
            
            if (result.success) {
                await storeCaption(url, result.caption);
            }
            res.json(result);
        } catch (fallbackError) {
            res.status(500).json({
                success: false,
                error: 'Failed to extract caption',
                message: error.message
            });
        }
    }
});

/**
 * Get all stored captions from database
 * GET /api/captions
 */
app.get('/api/captions', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const captions = await getAllCaptions(limit);
        
        res.json({
            success: true,
            total: captions.length,
            captions: captions,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error(`❌ Error: ${error.message}`);
        res.status(500).json({
            success: false,
            error: 'Database error',
            message: error.message
        });
    }
});

/**
 * Get captions for a specific username
 * GET /api/captions/:username
 */
app.get('/api/captions/:username', async (req, res) => {
    const { username } = req.params;
    
    try {
        const limit = parseInt(req.query.limit) || 50;
        const captions = await getCaptionsByUsername(username, limit);
        
        res.json({
            success: true,
            username: username,
            total: captions.length,
            captions: captions,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error(`❌ Error: ${error.message}`);
        res.status(500).json({
            success: false,
            error: 'Database error',
            message: error.message
        });
    }
});

// Serve a simple HTML page for testing
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Copytext Caption Automation</title>
            <style>
                body { font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }
                h1 { color: #333; }
                input, textarea { width: 100%; padding: 10px; margin: 10px 0; border: 1px solid #ddd; border-radius: 4px; }
                button { padding: 10px 20px; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; }
                button:hover { background: #0056b3; }
                .result { margin-top: 20px; padding: 15px; background: #f5f5f5; border-radius: 4px; white-space: pre-wrap; }
                .error { color: red; }
                .success { color: green; }
                .nav { margin: 10px 0; }
                .nav a { margin-right: 15px; color: #007bff; }
            </style>
        </head>
        <body>
            <h1>📝 Copytext Caption Automation</h1>
            <div class="nav">
                <a href="/api/captions">View All Captions</a>
                <a href="/api/health">Health Check</a>
            </div>
            <p>Paste an Instagram URL to extract the caption</p>
            
            <input type="text" id="url" placeholder="https://www.instagram.com/..." value="https://www.instagram.com/nasa/reel/Dcwk7e1yHaY/" />
            <button onclick="getCaption()">Get Caption</button>
            
            <div id="result" class="result" style="display:none;"></div>
            <div id="loading" style="display:none;">⏳ Extracting caption...</div>
            
            <script>
                async function getCaption() {
                    const url = document.getElementById('url').value;
                    const resultDiv = document.getElementById('result');
                    const loadingDiv = document.getElementById('loading');
                    
                    if (!url) {
                        resultDiv.style.display = 'block';
                        resultDiv.className = 'result error';
                        resultDiv.textContent = '❌ Please enter a URL';
                        return;
                    }
                    
                    loadingDiv.style.display = 'block';
                    resultDiv.style.display = 'none';
                    
                    try {
                        const response = await fetch('/api/caption?url=' + encodeURIComponent(url));
                        const data = await response.json();
                        
                        loadingDiv.style.display = 'none';
                        resultDiv.style.display = 'block';
                        
                        if (data.success && data.caption) {
                            const source = data.source || 'scraped';
                            resultDiv.className = 'result success';
                            resultDiv.innerHTML = \`
                                <strong>✅ Caption Extracted!</strong>
                                <p><strong>Source:</strong> \${source}</p>
                                <p><strong>Author:</strong> \${data.author || 'Unknown'}</p>
                                <p><strong>Length:</strong> \${data.caption.length} characters</p>
                                <hr>
                                <p>\${data.caption}</p>
                            \`;
                        } else {
                            resultDiv.className = 'result error';
                            resultDiv.textContent = '❌ ' + (data.error || 'No caption found');
                        }
                    } catch (error) {
                        loadingDiv.style.display = 'none';
                        resultDiv.style.display = 'block';
                        resultDiv.className = 'result error';
                        resultDiv.textContent = '❌ Error: ' + error.message;
                    }
                }
            </script>
        </body>
        </html>
    `);
});

// Start the server
app.listen(PORT, () => {
    console.log(`🚀 Copytext Caption Automation running on port ${PORT}`);
    console.log(`📝 Test it: http://localhost:${PORT}`);
    console.log(`📡 API: POST /api/caption`);
    console.log(`📡 API: POST /api/caption/batch`);
    console.log(`📡 API: GET /api/caption?url=...`);
    console.log(`📡 API: GET /api/captions (view all stored captions)`);
    console.log(`📡 API: GET /api/captions/:username`);
    console.log(`💾 Database: ${process.env.DATABASE_URL ? 'Configured' : 'Not configured'}`);
});