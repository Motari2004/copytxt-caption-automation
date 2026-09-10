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
const WEBHOOK_TIMEOUT = parseInt(process.env.WEBHOOK_TIMEOUT) || 60000;  // ⭐ 60s (was 30s)
const WEBHOOK_MAX_RETRIES = parseInt(process.env.WEBHOOK_MAX_RETRIES) || 5;  // ⭐ 5 (was 3)
const WEBHOOK_RETRY_DELAY = 2000;  // 2 seconds base delay

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

        await pool.query(`CREATE INDEX IF NOT EXISTS idx_captions_url ON captions(url)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_captions_username ON captions(username)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_captions_created_at ON captions(created_at DESC)`);
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

// ============== ⭐ IMPROVED WEBHOOK HELPER WITH RETRY ⭐ ==============

async function sendWebhookWithRetry(webhook_url, payload, maxRetries = WEBHOOK_MAX_RETRIES) {
    if (!webhook_url) {
        console.log(`⚠️ No webhook_url provided — skipping`);
        return { sent: false, reason: 'no_webhook_url' };
    }

    // Deduplication key
    const webhookKey = `${webhook_url}_${payload.reel_url}`;

    if (pendingWebhooks.has(webhookKey)) {
        console.log(`⏭️ Skipping duplicate webhook for ${payload.reel_url.substring(0, 50)}...`);
        return { sent: false, reason: 'duplicate' };
    }

    pendingWebhooks.set(webhookKey, { started_at: new Date().toISOString() });

    let lastError = null;
    let lastStatus = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`📤 [Attempt ${attempt}/${maxRetries}] Sending webhook to: ${webhook_url}`);
            console.log(`    Payload: reel_url=${payload.reel_url?.substring(0, 50)}..., caption_len=${payload.caption?.length || 0}`);

            const response = await axios.post(webhook_url, payload, {
                timeout: WEBHOOK_TIMEOUT,
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'CopytextCaptionService/1.0'
                },
                // ⭐ Don't throw on non-2xx — we handle status codes ourselves
                validateStatus: () => true,
            });

            lastStatus = response.status;

            // ⭐ Accept ANY 2xx response
            if (response.status >= 200 && response.status < 300) {
                console.log(`✅ Webhook delivered successfully (HTTP ${response.status}, attempt ${attempt})`);
                pendingWebhooks.delete(webhookKey);
                return { sent: true, status: response.status, attempts: attempt };
            }

            // ⭐ 4xx errors: don't retry (bad payload/URL)
            if (response.status >= 400 && response.status < 500) {
                console.error(`❌ Webhook returned ${response.status} (4xx) — NOT retrying`);
                console.error(`   Response body: ${JSON.stringify(response.data).substring(0, 300)}`);
                pendingWebhooks.delete(webhookKey);
                return { sent: false, status: response.status, reason: 'client_error', attempts: attempt };
            }

            // ⭐ 5xx errors: retry
            console.warn(`⚠️ Webhook returned ${response.status} (5xx) — will retry`);
            lastError = `HTTP ${response.status}`;

        } catch (error) {
            if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
                console.warn(`⏰ Webhook timeout after ${WEBHOOK_TIMEOUT}ms (attempt ${attempt})`);
                lastError = 'Timeout';
            } else if (error.code === 'ECONNREFUSED') {
                console.error(`🔌 Connection refused (attempt ${attempt}) — is the backend URL correct?`);
                lastError = 'Connection refused';
            } else if (error.response) {
                console.warn(`⚠️ Webhook error HTTP ${error.response.status} (attempt ${attempt})`);
                lastError = `HTTP ${error.response.status}`;
            } else {
                console.error(`❌ Webhook error: ${error.message} (attempt ${attempt})`);
                lastError = error.message;
            }
        }

        // Retry with exponential backoff
        if (attempt < maxRetries) {
            const delay = WEBHOOK_RETRY_DELAY * Math.pow(2, attempt - 1);
            console.log(`⏳ Retrying in ${delay / 1000}s...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    console.error(`❌ All ${maxRetries} webhook attempts failed. Last error: ${lastError}`);
    pendingWebhooks.delete(webhookKey);
    return { sent: false, reason: lastError || 'unknown', attempts: maxRetries };
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
            version: '1.1.0',  // ⭐ bumped
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
            version: '1.1.0',
            uptime: process.uptime(),
            database: 'disconnected'
        });
    }
});

/**
 * ⭐ Get caption for a single URL — now with proper webhook reporting
 */
app.post('/api/caption', async (req, res) => {
    const {
        url,
        username,
        job_id,
        webhook_url,
        pipeline_id,
        profile_username,
        post_id,               // ⭐ added
        async: asyncMode
    } = req.body;

    if (!url) {
        return res.status(400).json({
            error: 'Missing url parameter',
            message: 'Please provide an Instagram URL'
        });
    }

    const pendingKey = url;

    // Deduplication: check if already pending
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

    // ⭐ Wrap logic in a promise for deduplication
    const requestPromise = (async () => {
        try {
            // ══════════════════════════════════════════════════════
            // STEP 1: Check if we already have the caption cached
            // ══════════════════════════════════════════════════════
            const dbResult = await getCaptionFromDB(url);

            let caption = null;
            let source = null;

            if (dbResult && dbResult.caption) {
                caption = dbResult.caption;
                source = 'database';
                console.log(`📦 Using cached caption for: ${url.substring(0, 50)}...`);
            } else {
                // ══════════════════════════════════════════════════════
                // STEP 2: Scrape the caption
                // ══════════════════════════════════════════════════════
                console.log(`📝 Scraping URL: ${url}`);
                const scrapeResult = await getCaptionFromCopytext(url);

                if (scrapeResult.success) {
                    caption = scrapeResult.caption;
                    source = 'scraped';

                    // Store in caption service's own DB
                    await storeCaption(url, caption, username);
                } else {
                    // Scrape failed — send failure webhook and return
                    console.error(`❌ Scrape failed for ${url}: ${scrapeResult.error}`);

                    let webhookResult = { sent: false };
                    if (webhook_url) {
                        // ⭐ Await the webhook so we know if it succeeded
                        webhookResult = await sendWebhookWithRetry(webhook_url, {
                            reel_url: url,
                            caption: null,
                            job_id: job_id,
                            status: 'failed',
                            error: scrapeResult.error || 'No caption found',
                            profile_username: profile_username || username,
                            pipeline_id: pipeline_id,
                            post_id: post_id,
                            timestamp: new Date().toISOString()
                        });
                    }

                    return {
                        success: false,
                        url: url,
                        error: 'Could not extract caption',
                        message: scrapeResult.error || 'No caption found',
                        webhook_sent: webhookResult.sent,
                        webhook_reason: webhookResult.reason || null
                    };
                }
            }

            // ══════════════════════════════════════════════════════
            // STEP 3: Send success webhook (if we have a URL to send to)
            // ══════════════════════════════════════════════════════
            let webhookResult = { sent: false, reason: 'no_webhook_url' };

            if (webhook_url) {
                // ⭐ AWAIT so we know delivery status
                webhookResult = await sendWebhookWithRetry(webhook_url, {
                    reel_url: url,
                    caption: caption,
                    job_id: job_id,
                    status: 'completed',
                    profile_username: profile_username || username,
                    pipeline_id: pipeline_id,
                    post_id: post_id,           // ⭐ pass post_id
                    source: source,
                    timestamp: new Date().toISOString()
                });

                console.log(`📤 Webhook delivery summary: sent=${webhookResult.sent}, reason=${webhookResult.reason || 'n/a'}`);
            }

            // ══════════════════════════════════════════════════════
            // STEP 4: Return the response (with webhook status)
            // ══════════════════════════════════════════════════════
            return {
                success: true,
                url: url,
                caption: caption,
                length: caption.length,
                source: source,
                webhook_sent: webhookResult.sent,           // ⭐ NEW
                webhook_status: webhookResult.status || null,
                webhook_attempts: webhookResult.attempts || 0,
                timestamp: new Date().toISOString()
            };

        } catch (error) {
            console.error(`❌ Error processing ${url}:`, error.message);

            // Send error webhook
            let webhookResult = { sent: false };
            if (webhook_url) {
                webhookResult = await sendWebhookWithRetry(webhook_url, {
                    reel_url: url,
                    caption: null,
                    job_id: job_id,
                    status: 'failed',
                    error: error.message,
                    profile_username: profile_username || username,
                    pipeline_id: pipeline_id,
                    post_id: post_id,
                    timestamp: new Date().toISOString()
                });
            }

            throw error;
        }
    })();

    // Register as pending
    pendingRequests.set(pendingKey, requestPromise);

    // Cleanup
    requestPromise.finally(() => {
        pendingRequests.delete(pendingKey);
        console.log(`🧹 Cleaned up pending request for ${url.substring(0, 50)}...`);
    });

    // Await and respond
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

/**
 * ⭐ NEW: Test webhook delivery manually
 */
app.post('/api/test-webhook', async (req, res) => {
    const { webhook_url, reel_url = 'https://instagram.com/reel/TEST123' } = req.body;

    if (!webhook_url) {
        return res.status(400).json({ error: 'webhook_url required in body' });
    }

    console.log(`🧪 Testing webhook to: ${webhook_url}`);

    const result = await sendWebhookWithRetry(webhook_url, {
        reel_url: reel_url,
        caption: 'This is a TEST caption from the caption service',
        job_id: 'test-' + Date.now(),
        status: 'completed',
        profile_username: 'test_user',
        pipeline_id: 'test-pipeline-id',
        post_id: 'test-post-id',
        source: 'test',
        timestamp: new Date().toISOString()
    });

    res.json({
        success: result.sent,
        message: result.sent ? 'Webhook delivered successfully' : 'Webhook delivery failed',
        target: webhook_url,
        attempts: result.attempts || 0,
        status: result.status || null,
        reason: result.reason || null
    });
});

/**
 * ⭐ NEW: Batch get multiple captions
 */
app.post('/api/captions/batch', async (req, res) => {
    const { urls = [], webhook_url, pipeline_id, profile_username } = req.body;

    if (!Array.isArray(urls) || urls.length === 0) {
        return res.status(400).json({ error: 'urls array required' });
    }

    console.log(`📦 Batch request: ${urls.length} URLs`);

    const results = [];

    for (const url of urls) {
        try {
            const dbResult = await getCaptionFromDB(url);

            if (dbResult && dbResult.caption) {
                results.push({
                    url,
                    success: true,
                    caption: dbResult.caption,
                    source: 'database'
                });
            } else {
                const scrapeResult = await getCaptionFromCopytext(url);

                if (scrapeResult.success) {
                    await storeCaption(url, scrapeResult.caption, profile_username);
                    results.push({
                        url,
                        success: true,
                        caption: scrapeResult.caption,
                        source: 'scraped'
                    });
                } else {
                    results.push({
                        url,
                        success: false,
                        error: scrapeResult.error
                    });
                }
            }
        } catch (error) {
            results.push({
                url,
                success: false,
                error: error.message
            });
        }
    }

    res.json({
        success: true,
        total: urls.length,
        results
    });
});

/**
 * Get all stored captions
 */
app.get('/api/captions', async (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const captions = await getAllCaptions(limit);
    res.json({ success: true, total: captions.length, captions });
});

/**
 * Get captions by username
 */
app.get('/api/captions/user/:username', async (req, res) => {
    const { username } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const captions = await getCaptionsByUsername(username, limit);
    res.json({ success: true, username, total: captions.length, captions });
});

// ============== SERVER START ==============

app.listen(PORT, () => {
    console.log(`🚀 Copytext Caption Automation running on port ${PORT}`);
    console.log(`⏰ Webhook timeout: ${WEBHOOK_TIMEOUT}ms`);
    console.log(`🔄 Webhook max retries: ${WEBHOOK_MAX_RETRIES}`);
    console.log(`🔄 Deduplication: Enabled`);
    console.log(`⭐ Version: 1.1.0 (with proper webhook reporting)`);
});