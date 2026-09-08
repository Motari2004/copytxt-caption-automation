/**
 * Copytext Caption Automation Service
 * Deploy on Render
 */

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { getCaptionFromCopytext, processBatch } = require('./scraper');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ============== CONFIGURATION ==============
const WEBHOOK_TIMEOUT = parseInt(process.env.WEBHOOK_TIMEOUT) || 30000; // 30 seconds
const WEBHOOK_MAX_RETRIES = parseInt(process.env.WEBHOOK_MAX_RETRIES) || 3;
const WEBHOOK_RETRY_DELAY = 2000; // 2 seconds base delay

// ============== REQUEST DEDUPLICATION ==============
const pendingRequests = new Map();
const pendingWebhooks = new Map();

// ============== DATABASE CONNECTION ==============

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// ============== AUTO CREATE TABLES ==============

async function initDatabase() {
    try {
        console.log('📦 Initializing database...');
        
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

// ============== WEBHOOK HELPER WITH RETRY ==============

async function sendWebhookWithRetry(webhook_url, payload, maxRetries = WEBHOOK_MAX_RETRIES) {
    if (!webhook_url) return true;
    
    // Create a unique key for this webhook
    const webhookKey = `${webhook_url}_${payload.reel_url}`;
    
    // Only send if this webhook hasn't been sent yet
    if (pendingWebhooks.has(webhookKey)) {
        console.log(`⏭️ Skipping duplicate webhook for ${payload.reel_url.substring(0, 50)}...`);
        return true;
    }
    
    // Mark as pending
    pendingWebhooks.set(webhookKey, true);
    
    let lastError = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`📤 Sending webhook (attempt ${attempt}/${maxRetries}) to: ${webhook_url}`);
            
            const response = await axios.post(webhook_url, payload, {
                timeout: WEBHOOK_TIMEOUT,
                headers: { 
                    'Content-Type': 'application/json',
                    'User-Agent': 'CopytextCaptionService/1.0'
                }
            });
            
            if (response.status >= 200 && response.status < 300) {
                console.log(`✅ Webhook sent successfully (attempt ${attempt})`);
                pendingWebhooks.delete(webhookKey);
                return true;
            }
            
            console.log(`⚠️ Webhook returned ${response.status} (attempt ${attempt})`);
            lastError = `HTTP ${response.status}`;
            
        } catch (error) {
            if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
                console.log(`⏰ Webhook timeout (attempt ${attempt})`);
                lastError = 'Timeout';
            } else if (error.response) {
                console.log(`⚠️ Webhook error: ${error.response.status} (attempt ${attempt})`);
                lastError = `HTTP ${error.response.status}`;
            } else {
                console.log(`❌ Webhook error: ${error.message} (attempt ${attempt})`);
                lastError = error.message;
            }
        }
        
        // If not the last attempt, wait with exponential backoff
        if (attempt < maxRetries) {
            const delay = WEBHOOK_RETRY_DELAY * Math.pow(2, attempt - 1);
            console.log(`⏳ Retrying in ${delay/1000}s...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    
    // All retries failed
    console.error(`❌ All ${maxRetries} webhook attempts failed: ${lastError}`);
    pendingWebhooks.delete(webhookKey);
    return false;
}

// Legacy function for backward compatibility
async function sendWebhook(webhook_url, payload) {
    return sendWebhookWithRetry(webhook_url, payload, 1);
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
            database: 'connected',
            pending_requests: pendingRequests.size,
            pending_webhooks: pendingWebhooks.size,
            webhook_timeout: WEBHOOK_TIMEOUT,
            webhook_max_retries: WEBHOOK_MAX_RETRIES
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
 * Get caption for a single URL with deduplication
 */
app.post('/api/caption', async (req, res) => {
    const { 
        url, 
        username, 
        job_id, 
        webhook_url, 
        pipeline_id, 
        profile_username,
        async: asyncMode 
    } = req.body;
    
    if (!url) {
        return res.status(400).json({ 
            error: 'Missing url parameter',
            message: 'Please provide an Instagram URL'
        });
    }
    
    const pendingKey = url;
    
    // Check if already pending
    if (pendingRequests.has(pendingKey)) {
        console.log(`⏳ Request for ${url.substring(0, 50)}... already pending, waiting...`);
        
        try {
            const result = await pendingRequests.get(pendingKey);
            console.log(`✅ Got result from pending request for ${url.substring(0, 50)}...`);
            return res.json(result);
        } catch (error) {
            console.error(`❌ Pending request failed:`, error.message);
        }
    }
    
    // Create a promise for this request
    const requestPromise = (async () => {
        try {
            // Check database first
            const dbResult = await getCaptionFromDB(url);
            
            if (dbResult && dbResult.caption) {
                console.log(`📦 Found caption in database for: ${url.substring(0, 50)}...`);
                
                const result = {
                    success: true,
                    url: url,
                    caption: dbResult.caption,
                    length: dbResult.caption.length,
                    source: 'database',
                    timestamp: new Date().toISOString()
                };
                
                // ✅ Send webhook ASYNC (don't wait for response)
                if (webhook_url) {
                    sendWebhookWithRetry(webhook_url, {
                        reel_url: url,
                        caption: dbResult.caption,
                        job_id: job_id,
                        status: 'completed',
                        profile_username: profile_username || username,
                        pipeline_id: pipeline_id,
                        source: 'database',
                        timestamp: new Date().toISOString()
                    }).catch(err => console.error(`Webhook error: ${err.message}`));
                }
                
                return result;
            }
            
            console.log(`📝 Processing URL: ${url}`);
            const result = await getCaptionFromCopytext(url);
            
            if (result.success) {
                // Store in database
                await storeCaption(url, result.caption, username);
                
                // ✅ Send webhook ASYNC (don't wait for response)
                if (webhook_url) {
                    sendWebhookWithRetry(webhook_url, {
                        reel_url: url,
                        caption: result.caption,
                        job_id: job_id,
                        status: 'completed',
                        profile_username: profile_username || username,
                        pipeline_id: pipeline_id,
                        source: 'scraped',
                        timestamp: new Date().toISOString()
                    }).catch(err => console.error(`Webhook error: ${err.message}`));
                }
                
                return {
                    success: true,
                    url: result.url,
                    caption: result.caption,
                    length: result.caption.length,
                    source: 'scraped',
                    timestamp: new Date().toISOString()
                };
            } else {
                // Send failure webhook ASYNC
                if (webhook_url) {
                    sendWebhookWithRetry(webhook_url, {
                        reel_url: url,
                        caption: null,
                        job_id: job_id,
                        status: 'failed',
                        error: result.error || 'No caption found',
                        profile_username: profile_username || username,
                        pipeline_id: pipeline_id,
                        timestamp: new Date().toISOString()
                    }).catch(err => console.error(`Webhook error: ${err.message}`));
                }
                
                return {
                    success: false,
                    url: result.url,
                    error: 'Could not extract caption',
                    message: result.error || 'No caption found'
                };
            }
        } catch (error) {
            console.error(`❌ Error processing ${url}:`, error.message);
            
            // Send error webhook ASYNC
            if (webhook_url) {
                sendWebhookWithRetry(webhook_url, {
                    reel_url: url,
                    caption: null,
                    job_id: job_id,
                    status: 'failed',
                    error: error.message,
                    profile_username: profile_username || username,
                    pipeline_id: pipeline_id,
                    timestamp: new Date().toISOString()
                }).catch(err => console.error(`Webhook error: ${err.message}`));
            }
            
            throw error;
        }
    })();
    
    // Store the pending request
    pendingRequests.set(pendingKey, requestPromise);
    
    // Clean up after completion
    requestPromise.finally(() => {
        pendingRequests.delete(pendingKey);
        console.log(`🧹 Cleaned up pending request for ${url.substring(0, 50)}...`);
    });
    
    try {
        const result = await requestPromise;
        
        if (result.success) {
            return res.json(result);
        } else {
            return res.status(404).json(result);
        }
    } catch (error) {
        return res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: error.message
        });
    }
});

// ... rest of the routes remain the same ...

// Start the server
app.listen(PORT, () => {
    console.log(`🚀 Copytext Caption Automation running on port ${PORT}`);
    console.log(`⏰ Webhook timeout: ${WEBHOOK_TIMEOUT}ms`);
    console.log(`🔄 Webhook max retries: ${WEBHOOK_MAX_RETRIES}`);
    console.log(`🔄 Deduplication: Enabled`);
});