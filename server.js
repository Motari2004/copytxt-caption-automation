/**
 * Copytext Caption Automation Service
 * Synchronous Caption API — NO WEBHOOKS
 * Deploy on Render
 */

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const {
    getCaptionFromCopytext,
    processBatch
} = require('./scraper');

const app = express();

const PORT = process.env.PORT || 3000;

// ============================================================
// CONFIGURATION
// ============================================================

// Caption scraping timeout per attempt
const CAPTION_TIMEOUT =
    parseInt(process.env.CAPTION_TIMEOUT) || 60000;

// Maximum number of scraping attempts
const CAPTION_MAX_RETRIES =
    parseInt(process.env.CAPTION_MAX_RETRIES) || 4;

// Base retry delay
// Attempt 1 = immediate
// Attempt 2 = 5 seconds
// Attempt 3 = 10 seconds
// Attempt 4 = 20 seconds
const CAPTION_RETRY_DELAY =
    parseInt(process.env.CAPTION_RETRY_DELAY) || 5000;


// ============================================================
// REQUEST DEDUPLICATION
// ============================================================

const pendingRequests = new Map();


// ============================================================
// DATABASE CONNECTION
// ============================================================

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,

    ssl:
        process.env.NODE_ENV === 'production'
            ? { rejectUnauthorized: false }
            : false
});


// ============================================================
// DATABASE INITIALIZATION
// ============================================================

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
            CREATE INDEX IF NOT EXISTS idx_captions_url
            ON captions(url)
        `);


        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_captions_username
            ON captions(username)
        `);


        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_captions_created_at
            ON captions(created_at DESC)
        `);


        console.log('✅ Indexes ready');
        console.log('✅ Database initialized successfully');

    } catch (error) {

        console.error(
            '❌ Database initialization error:',
            error.message
        );

    }

}

initDatabase();


// ============================================================
// STORE CAPTION
// ============================================================

async function storeCaption(
    url,
    caption,
    username = null
) {

    try {

        const query = `
            INSERT INTO captions (
                url,
                caption,
                username,
                created_at,
                updated_at
            )

            VALUES (
                $1,
                $2,
                $3,
                NOW(),
                NOW()
            )

            ON CONFLICT (url)

            DO UPDATE SET

                caption = EXCLUDED.caption,

                username =
                    COALESCE(
                        EXCLUDED.username,
                        captions.username
                    ),

                updated_at = NOW()

            RETURNING id
        `;


        const result =
            await pool.query(
                query,
                [
                    url,
                    caption,
                    username
                ]
            );


        console.log(
            `✅ Stored caption in database for: ${url.substring(0, 80)}...`
        );


        return result.rows[0]?.id || null;

    } catch (error) {

        console.error(
            `❌ Failed to store caption: ${error.message}`
        );

        return null;
    }
}


// ============================================================
// GET CAPTION FROM DATABASE
// ============================================================

async function getCaptionFromDB(url) {

    try {

        const query = `
            SELECT
                caption,
                username,
                created_at,
                updated_at

            FROM captions

            WHERE url = $1

            ORDER BY created_at DESC

            LIMIT 1
        `;


        const result =
            await pool.query(
                query,
                [url]
            );


        if (result.rows.length > 0) {

            console.log(
                `📦 Found caption in database: ${url.substring(0, 80)}...`
            );

            return result.rows[0];
        }


        return null;

    } catch (error) {

        console.error(
            `❌ Database query error: ${error.message}`
        );

        return null;
    }
}


// ============================================================
// GET ALL CAPTIONS
// ============================================================

async function getAllCaptions(limit = 100) {

    try {

        const query = `
            SELECT
                url,
                caption,
                username,
                created_at,
                updated_at

            FROM captions

            ORDER BY created_at DESC

            LIMIT $1
        `;


        const result =
            await pool.query(
                query,
                [limit]
            );


        return result.rows;

    } catch (error) {

        console.error(
            `❌ Database query error: ${error.message}`
        );

        return [];
    }
}


// ============================================================
// GET CAPTIONS BY USERNAME
// ============================================================

async function getCaptionsByUsername(
    username,
    limit = 50
) {

    try {

        const query = `
            SELECT
                url,
                caption,
                created_at

            FROM captions

            WHERE username = $1

            ORDER BY created_at DESC

            LIMIT $2
        `;


        const result =
            await pool.query(
                query,
                [
                    username,
                    limit
                ]
            );


        return result.rows;

    } catch (error) {

        console.error(
            `❌ Database query error: ${error.message}`
        );

        return [];
    }
}


// ============================================================
// SLEEP HELPER
// ============================================================

function sleep(ms) {

    return new Promise(
        resolve => setTimeout(resolve, ms)
    );

}


// ============================================================
// CAPTION SCRAPER WITH RETRY
// ============================================================

async function getCaptionWithRetry(
    url,
    maxRetries = CAPTION_MAX_RETRIES
) {

    let lastError = null;


    for (
        let attempt = 1;
        attempt <= maxRetries;
        attempt++
    ) {

        console.log(
            `📞 [Attempt ${attempt}/${maxRetries}] Fetching caption for:`
        );

        console.log(
            `    ${url}`
        );


        try {

            // ------------------------------------------------
            // Start scraper
            // ------------------------------------------------

            const scrapePromise =
                getCaptionFromCopytext(url);


            // ------------------------------------------------
            // Timeout
            // ------------------------------------------------

            const timeoutPromise =
                new Promise(
                    (_, reject) => {

                        setTimeout(
                            () => {

                                reject(
                                    new Error(
                                        `Caption request timed out after ${CAPTION_TIMEOUT}ms`
                                    )
                                );

                            },
                            CAPTION_TIMEOUT
                        );

                    }
                );


            const result =
                await Promise.race([
                    scrapePromise,
                    timeoutPromise
                ]);


            // ------------------------------------------------
            // SUCCESS
            // ------------------------------------------------

            if (
                result &&
                result.success &&
                result.caption
            ) {

                console.log(
                    `✅ [Attempt ${attempt}] Got caption (${result.caption.length} chars)`
                );

                return result;
            }


            // ------------------------------------------------
            // SCRAPER RETURNED FAILURE
            // ------------------------------------------------

            lastError =
                result?.error ||
                'No caption found';


            console.warn(
                `⚠️ [Attempt ${attempt}] Caption extraction failed: ${lastError}`
            );


            // ------------------------------------------------
            // Detect permanent 404
            // ------------------------------------------------

            const errorText =
                String(lastError).toLowerCase();


            if (
                errorText.includes('404') ||
                errorText.includes('not found') ||
                errorText.includes('content is no longer available')
            ) {

                console.error(
                    `❌ Reel appears unavailable. Stopping retries.`
                );

                return {
                    success: false,
                    error: lastError
                };
            }


        } catch (error) {

            lastError =
                error.message ||
                'Unknown caption error';


            console.warn(
                `⚠️ [Attempt ${attempt}/${maxRetries}] ${lastError}`
            );

        }


        // ----------------------------------------------------
        // RETRY
        // ----------------------------------------------------

        if (attempt < maxRetries) {

            const delay =
                CAPTION_RETRY_DELAY *
                Math.pow(2, attempt - 1);


            console.log(
                `⏳ Retrying caption in ${delay / 1000}s...`
            );


            await sleep(delay);
        }

    }


    // ========================================================
    // ALL ATTEMPTS FAILED
    // ========================================================

    console.error(
        `❌ All ${maxRetries} caption attempts failed`
    );


    return {
        success: false,
        error:
            lastError ||
            'Could not extract caption after retries'
    };

}


// ============================================================
// MIDDLEWARE
// ============================================================

app.use(cors());

app.use(
    express.json({
        limit: '1mb'
    })
);

app.use(
    express.static('public')
);


// ============================================================
// HEALTH CHECK
// ============================================================

app.get(
    '/api/health',
    async (req, res) => {

        try {

            await pool.query(
                'SELECT NOW()'
            );


            res.json({

                status: 'healthy',

                service:
                    'Copytext Caption Automation',

                version: '2.0.0',

                uptime:
                    process.uptime(),

                database:
                    'connected',

                pending_requests:
                    pendingRequests.size,

                caption_timeout:
                    CAPTION_TIMEOUT,

                caption_max_retries:
                    CAPTION_MAX_RETRIES,

                caption_retry_delay:
                    CAPTION_RETRY_DELAY

            });

        } catch (error) {

            res.status(503).json({

                status: 'unhealthy',

                service:
                    'Copytext Caption Automation',

                version: '2.0.0',

                uptime:
                    process.uptime(),

                database:
                    'disconnected',

                error:
                    error.message

            });

        }

    }
);


// ============================================================
// MAIN CAPTION ENDPOINT
// ============================================================
//
// POST /api/caption
//
// Body:
//
// {
//   "url": "https://www.instagram.com/reel/xxxxx/",
//   "username": "username"
// }
//
// IMPORTANT:
// This endpoint is SYNCHRONOUS.
// It does NOT use webhooks.
//
// ============================================================

app.post(
    '/api/caption',
    async (req, res) => {

        const {
            url,
            username,
            profile_username
        } = req.body;


        // ----------------------------------------------------
        // Validate URL
        // ----------------------------------------------------

        if (!url) {

            return res.status(400).json({

                success: false,

                error:
                    'Missing url parameter',

                message:
                    'Please provide an Instagram URL'

            });

        }


        const pendingKey = url;


        // ====================================================
        // REQUEST DEDUPLICATION
        // ====================================================

        if (
            pendingRequests.has(pendingKey)
        ) {

            console.log(
                `⏳ Request already pending: ${url.substring(0, 80)}...`
            );


            try {

                const result =
                    await pendingRequests.get(
                        pendingKey
                    );


                console.log(
                    `✅ Returning result from pending request`
                );


                if (result.success) {

                    return res.json(result);

                }


                return res.status(404).json(result);

            } catch (error) {

                console.error(
                    `❌ Pending request failed:`,
                    error.message
                );

            }

        }


        // ====================================================
        // CREATE REQUEST PROMISE
        // ====================================================

        const requestPromise =
            (async () => {

                try {

                    // ========================================
                    // STEP 1
                    // CHECK DATABASE FIRST
                    // ========================================

                    console.log(
                        `📦 Checking caption database...`
                    );


                    const dbResult =
                        await getCaptionFromDB(url);


                    if (
                        dbResult &&
                        dbResult.caption
                    ) {

                        console.log(
                            `✅ Caption found in database`
                        );


                        return {

                            success: true,

                            url: url,

                            caption:
                                dbResult.caption,

                            length:
                                dbResult.caption.length,

                            source:
                                'database',

                            timestamp:
                                new Date().toISOString()

                        };

                    }


                    console.log(
                        `📭 Caption not in database`
                    );


                    // ========================================
                    // STEP 2
                    // SCRAPE WITH RETRIES
                    // ========================================

                    console.log(
                        `📝 Caption not cached — starting scraper`
                    );


                    const scrapeResult =
                        await getCaptionWithRetry(
                            url
                        );


                    if (
                        !scrapeResult ||
                        !scrapeResult.success ||
                        !scrapeResult.caption
                    ) {

                        console.error(
                            `❌ Caption extraction failed:`,
                            scrapeResult?.error
                        );


                        return {

                            success: false,

                            url: url,

                            error:
                                'Could not extract caption',

                            message:
                                scrapeResult?.error ||
                                'No caption found',

                            timestamp:
                                new Date().toISOString()

                        };

                    }


                    // ========================================
                    // STEP 3
                    // SAVE CAPTION
                    // ========================================

                    const caption =
                        scrapeResult.caption;


                    await storeCaption(
                        url,
                        caption,
                        username ||
                        profile_username ||
                        null
                    );


                    console.log(
                        `💾 Caption saved successfully`
                    );


                    // ========================================
                    // STEP 4
                    // RETURN CAPTION
                    // ========================================

                    return {

                        success: true,

                        url: url,

                        caption: caption,

                        length:
                            caption.length,

                        source:
                            'scraped',

                        timestamp:
                            new Date().toISOString()

                    };


                } catch (error) {

                    console.error(
                        `❌ Error processing caption:`,
                        error.message
                    );


                    return {

                        success: false,

                        url: url,

                        error:
                            'Internal caption service error',

                        message:
                            error.message,

                        timestamp:
                            new Date().toISOString()

                    };

                }

            })();


        // ====================================================
        // REGISTER PENDING REQUEST
        // ====================================================

        pendingRequests.set(
            pendingKey,
            requestPromise
        );


        // ====================================================
        // CLEANUP
        // ====================================================

        requestPromise.finally(
            () => {

                pendingRequests.delete(
                    pendingKey
                );


                console.log(
                    `🧹 Cleaned up pending request: ${url.substring(0, 80)}...`
                );

            }
        );


        // ====================================================
        // WAIT FOR RESULT
        // ====================================================

        try {

            const result =
                await requestPromise;


            if (result.success) {

                return res.json(result);

            }


            return res.status(404).json(result);

        } catch (error) {

            return res.status(500).json({

                success: false,

                error:
                    'Internal server error',

                message:
                    error.message

            });

        }

    }
);


// ============================================================
// BATCH CAPTIONS
// ============================================================

app.post(
    '/api/captions/batch',
    async (req, res) => {

        const {
            urls = [],
            profile_username
        } = req.body;


        if (
            !Array.isArray(urls) ||
            urls.length === 0
        ) {

            return res.status(400).json({

                success: false,

                error:
                    'urls array required'

            });

        }


        console.log(
            `📦 Batch request: ${urls.length} URLs`
        );


        const results = [];


        for (const url of urls) {

            try {

                // ------------------------------------------
                // DATABASE FIRST
                // ------------------------------------------

                const dbResult =
                    await getCaptionFromDB(url);


                if (
                    dbResult &&
                    dbResult.caption
                ) {

                    results.push({

                        url,

                        success: true,

                        caption:
                            dbResult.caption,

                        source:
                            'database'

                    });

                    continue;

                }


                // ------------------------------------------
                // SCRAPE WITH RETRIES
                // ------------------------------------------

                const scrapeResult =
                    await getCaptionWithRetry(
                        url
                    );


                if (
                    scrapeResult.success &&
                    scrapeResult.caption
                ) {

                    await storeCaption(
                        url,
                        scrapeResult.caption,
                        profile_username ||
                        null
                    );


                    results.push({

                        url,

                        success: true,

                        caption:
                            scrapeResult.caption,

                        source:
                            'scraped'

                    });

                } else {

                    results.push({

                        url,

                        success: false,

                        error:
                            scrapeResult.error ||
                            'No caption found'

                    });

                }

            } catch (error) {

                results.push({

                    url,

                    success: false,

                    error:
                        error.message

                });

            }

        }


        return res.json({

            success: true,

            total:
                urls.length,

            results

        });

    }
);


// ============================================================
// GET ALL CAPTIONS
// ============================================================

app.get(
    '/api/captions',
    async (req, res) => {

        const limit =
            parseInt(req.query.limit) ||
            100;


        const captions =
            await getAllCaptions(
                Math.min(limit, 1000)
            );


        res.json({

            success: true,

            total:
                captions.length,

            captions

        });

    }
);


// ============================================================
// GET CAPTIONS BY USERNAME
// ============================================================

app.get(
    '/api/captions/user/:username',
    async (req, res) => {

        const {
            username
        } = req.params;


        const limit =
            parseInt(req.query.limit) ||
            50;


        const captions =
            await getCaptionsByUsername(
                username,
                Math.min(limit, 500)
            );


        res.json({

            success: true,

            username,

            total:
                captions.length,

            captions

        });

    }
);


// ============================================================
// 404 HANDLER
// ============================================================

app.use(
    (req, res) => {

        res.status(404).json({

            success: false,

            error:
                'Endpoint not found',

            path:
                req.path

        });

    }
);


// ============================================================
// ERROR HANDLER
// ============================================================

app.use(
    (error, req, res, next) => {

        console.error(
            '❌ Unhandled server error:',
            error
        );


        if (res.headersSent) {

            return next(error);

        }


        res.status(500).json({

            success: false,

            error:
                'Internal server error',

            message:
                error.message

        });

    }
);


// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

async function shutdown(signal) {

    console.log(
        `\n🛑 Received ${signal}. Shutting down...`
    );


    try {

        await pool.end();

        console.log(
            '✅ Database connection closed'
        );


        process.exit(0);

    } catch (error) {

        console.error(
            '❌ Shutdown error:',
            error.message
        );


        process.exit(1);

    }

}


process.on(
    'SIGTERM',
    () => shutdown('SIGTERM')
);

process.on(
    'SIGINT',
    () => shutdown('SIGINT')
);


// ============================================================
// START SERVER
// ============================================================

app.listen(
    PORT,
    () => {

        console.log('');
        console.log(
            '🚀 Copytext Caption Automation Service'
        );

        console.log(
            `🌐 Running on port ${PORT}`
        );

        console.log(
            '🔗 Webhooks: DISABLED'
        );

        console.log(
            `⏰ Caption timeout: ${CAPTION_TIMEOUT}ms`
        );

        console.log(
            `🔄 Caption max retries: ${CAPTION_MAX_RETRIES}`
        );

        console.log(
            `⏳ Retry delays: 5s → 10s → 20s`
        );

        console.log(
            '📦 Database cache: ENABLED'
        );

        console.log(
            '🔁 Request deduplication: ENABLED'
        );

        console.log(
            '⭐ Version: 2.0.0'
        );

        console.log('');

    }
);