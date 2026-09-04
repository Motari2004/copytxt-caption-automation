/**
 * Copytext scraper using Playwright with Browser Reuse
 */

require('dotenv').config();

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const COPYTEXT_URL = 'https://copytext.app';

// ============== BROWSER POOL ==============
// 🔥 Shared browser instance reused across requests

let sharedBrowser = null;
let browserRefCount = 0;
let browserLock = false;
let pendingRequests = [];

async function getBrowser() {
    // If browser exists and is connected, use it
    if (sharedBrowser && sharedBrowser.isConnected()) {
        browserRefCount++;
        console.log(`🔄 Reusing browser (ref count: ${browserRefCount})`);
        return sharedBrowser;
    }
    
    // If browser is being created, wait for it
    if (browserLock) {
        console.log('⏳ Waiting for browser to be created...');
        return new Promise((resolve) => {
            pendingRequests.push(resolve);
        });
    }
    
    browserLock = true;
    
    try {
        console.log('🚀 Creating new browser instance...');
        const browserPath = getBrowserPath();
        
        const launchOptions = { 
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu'
            ]
        };
        
        if (browserPath) {
            launchOptions.executablePath = browserPath;
            console.log(`✅ Using browser at: ${browserPath}`);
        }
        
        sharedBrowser = await chromium.launch(launchOptions);
        browserRefCount = 1;
        console.log('✅ Browser launched successfully (shared)');
        
        // Resolve any pending requests
        for (const resolve of pendingRequests) {
            resolve(sharedBrowser);
        }
        pendingRequests = [];
        
        return sharedBrowser;
        
    } catch (error) {
        console.error('❌ Failed to launch browser:', error.message);
        throw error;
    } finally {
        browserLock = false;
    }
}

function releaseBrowser() {
    browserRefCount--;
    console.log(`🔽 Releasing browser (ref count: ${browserRefCount})`);
    
    // Schedule browser close after 60 seconds of inactivity
    if (browserRefCount <= 0 && sharedBrowser) {
        console.log('⏳ Scheduling browser close in 60 seconds...');
        setTimeout(async () => {
            if (browserRefCount <= 0 && sharedBrowser && sharedBrowser.isConnected()) {
                try {
                    await sharedBrowser.close();
                    sharedBrowser = null;
                    console.log('🔒 Browser closed (idle timeout)');
                } catch (e) {
                    console.log('⚠️ Browser already closed');
                    sharedBrowser = null;
                }
            }
        }, 60000); // Close after 60 seconds idle
    }
}

function getBrowserPath() {
    if (process.env.PLAYWRIGHT_CHROME_PATH) {
        return process.env.PLAYWRIGHT_CHROME_PATH;
    }
    
    const commonPaths = [
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        path.join(process.env.PLAYWRIGHT_BROWSERS_PATH || '', 'chromium-1200/chrome-win64/chrome.exe'),
        path.join(process.env.PLAYWRIGHT_BROWSERS_PATH || '', 'chromium-1234/chrome-win64/chrome.exe'),
    ];
    
    for (const p of commonPaths) {
        if (fs.existsSync(p)) {
            return p;
        }
    }
    
    return null;
}

// ============== FAST OEmbed METHOD ==============

async function getCaptionViaOEmbed(reelUrl) {
    try {
        const oembedUrl = `https://api.instagram.com/oembed?url=${encodeURIComponent(reelUrl)}`;
        const response = await axios.get(oembedUrl, { timeout: 5000 });
        
        if (response.data && response.data.title) {
            console.log(`✅ Got caption via oEmbed (fast!)`);
            return {
                caption: response.data.title,
                success: true,
                method: 'oembed',
                url: reelUrl
            };
        }
        return null;
    } catch (error) {
        return null;
    }
}

// ============== MAIN CAPTION FUNCTION ==============

/**
 * Get caption from copytext.app using Playwright with browser reuse
 */
async function getCaptionFromCopytext(reelUrl) {
    console.log(`📝 Fetching caption for: ${reelUrl.substring(0, 50)}...`);
    
    // 🔥 Try oEmbed first (fastest)
    const oembedResult = await getCaptionViaOEmbed(reelUrl);
    if (oembedResult && oembedResult.caption) {
        return oembedResult;
    }
    
    let browser = null;
    let context = null;
    let page = null;
    let caption = '';
    let isShared = false;
    
    try {
        // 🔥 Get shared browser
        browser = await getBrowser();
        isShared = true;
        
        // Create new context and page for each request
        context = await browser.newContext({
            viewport: { width: 1280, height: 900 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        });
        
        page = await context.newPage();
        
        console.log('🌐 Going to copytext.app...');
        await page.goto(COPYTEXT_URL, { 
            waitUntil: 'domcontentloaded', 
            timeout: 30000 
        });
        
        // Wait for page to be ready
        await page.waitForTimeout(2000);
        
        console.log('📝 Pasting URL...');
        const textbox = page.getByRole('textbox', { name: 'Paste an Instagram link…' });
        await textbox.waitFor({ state: 'visible', timeout: 10000 });
        await textbox.fill(reelUrl);
        
        await page.waitForTimeout(1000);
        
        console.log('🔍 Clicking "Get text"...');
        const getTextButton = page.getByRole('button', { name: 'Get text' });
        await getTextButton.waitFor({ state: 'visible', timeout: 10000 });
        await getTextButton.click();
        
        console.log('⏳ Waiting for caption...');
        await page.waitForTimeout(4000);
        
        console.log('📋 Clicking "Copy"...');
        const copyButton = page.getByRole('button', { name: 'Copy' });
        await copyButton.waitFor({ state: 'visible', timeout: 10000 });
        await copyButton.click();
        
        await page.waitForTimeout(1500);
        
        // Extract caption using exact selector
        console.log('📝 Extracting caption...');
        
        try {
            await page.waitForSelector('#successState', { timeout: 8000 });
            const captionTextBox = page.locator('#successState').getByRole('textbox');
            await captionTextBox.waitFor({ state: 'visible', timeout: 3000 });
            
            caption = await captionTextBox.inputValue();
            if (caption && caption.trim().length > 10) {
                caption = caption.trim();
                console.log(`✅ Found caption via inputValue: ${caption.substring(0, 50)}...`);
            } else {
                caption = await captionTextBox.textContent();
                if (caption && caption.trim().length > 10) {
                    caption = caption.trim();
                    console.log(`✅ Found caption via textContent: ${caption.substring(0, 50)}...`);
                }
            }
        } catch (e) {
            console.log('⚠️ Could not find #successState, trying fallback...');
        }
        
        // Fallback: Use clipboard
        if (!caption || caption.length < 20) {
            try {
                const clipboardText = await page.evaluate(() => {
                    return navigator.clipboard.readText().catch(() => '');
                });
                if (clipboardText && clipboardText.length > 20) {
                    caption = clipboardText;
                    console.log('✅ Found caption via clipboard (fallback)');
                }
            } catch (e) {}
        }
        
        // Fallback: Use result area
        if (!caption || caption.length < 20) {
            try {
                const resultText = await page.evaluate(() => {
                    const elements = document.querySelectorAll('div, p, span');
                    let foundCaption = '';
                    
                    for (const el of elements) {
                        const text = el.textContent || '';
                        if (text.includes('Extracted caption') || text.includes('提取的文案')) {
                            const parent = el.parentElement;
                            if (parent) {
                                let cleanText = parent.textContent || '';
                                cleanText = cleanText.replace(/Extracted caption|提取的文案/g, '').trim();
                                cleanText = cleanText.replace(/Edit|Copy|📋|✏️/g, '').trim();
                                if (cleanText.length > 20) {
                                    return cleanText;
                                }
                            }
                        }
                    }
                    
                    for (const el of elements) {
                        const text = el.textContent || '';
                        if (text.length > 50 && 
                            !text.includes('Paste an Instagram link') &&
                            !text.includes('Get text') &&
                            !text.includes('copytext') &&
                            !text.includes('Cookie') &&
                            !text.includes('Language') &&
                            !text.includes('History') &&
                            !text.includes('Sync') &&
                            !text.includes('Edit') &&
                            !text.includes('Copy') &&
                            !text.includes('Developed by') &&
                            !text.includes('Wisenheimer') &&
                            text.length > 30) {
                            return text.trim();
                        }
                    }
                    return '';
                });
                
                if (resultText) {
                    caption = resultText;
                    console.log('✅ Found caption via result area (fallback)');
                }
            } catch (e) {}
        }
        
        // Clean up caption
        if (caption) {
            const removePatterns = [
                /copytext\s*Developed by Wisenheimer/gi,
                /Paste an Instagram link[^\n]*/gi,
                /Get text/gi,
                /Copy/gi,
                /Edit/gi,
                /TAP TO EDIT/gi,
                /SAVE/gi,
                /history/gi,
                /Sync your history[^\n]*/gi,
                /Sign in with Google[^\n]*/gi,
                /Remove ads/gi,
                /Sign out/gi,
                /Not now/gi,
                /Transfer/gi,
                /Language[\s\S]*?English/gi,
                /We use cookies for ads[^\n]*/gi,
                /Accept/gi,
                /Decline/gi,
                /Try again/gi,
                /Advertisement/gi,
                /©.*$/gi
            ];
            
            for (const pattern of removePatterns) {
                caption = caption.replace(pattern, '');
            }
            caption = caption.replace(/\s+/g, ' ').trim();
        }
        
        await context.close();
        releaseBrowser();
        
        console.log(`📊 Final caption length: ${caption ? caption.length : 0} characters`);
        
        return {
            caption: caption || '',
            success: caption && caption.length > 20,
            url: reelUrl,
            method: 'copytext'
        };
        
    } catch (error) {
        console.error(`❌ Error: ${error.message}`);
        
        if (page) await page.close().catch(() => {});
        if (context) await context.close().catch(() => {});
        if (isShared) {
            releaseBrowser();
        } else if (browser) {
            await browser.close().catch(() => {});
        }
        
        return {
            caption: '',
            success: false,
            error: error.message,
            url: reelUrl
        };
    }
}

// ============== BATCH PROCESSING WITH CONCURRENCY ==============

/**
 * Process multiple URLs with concurrency control
 */
async function processBatch(urls, concurrency = 3) {
    const results = [];
    const chunkSize = concurrency;
    
    console.log(`📋 Processing ${urls.length} URLs with concurrency ${concurrency}`);
    
    // Process in chunks
    for (let i = 0; i < urls.length; i += chunkSize) {
        const chunk = urls.slice(i, i + chunkSize);
        const chunkNum = Math.floor(i / chunkSize) + 1;
        const totalChunks = Math.ceil(urls.length / chunkSize);
        
        console.log(`\n📦 Chunk ${chunkNum}/${totalChunks}: ${chunk.length} URLs`);
        
        // Process chunk in parallel
        const chunkResults = await Promise.all(
            chunk.map(async (url) => {
                const trimmedUrl = url.trim();
                if (!trimmedUrl) return null;
                
                const result = await getCaptionFromCopytext(trimmedUrl);
                return {
                    url: result.url,
                    caption: result.caption || '',
                    success: result.success,
                    method: result.method || 'copytext',
                    timestamp: new Date().toISOString()
                };
            })
        );
        
        // Add results from this chunk
        for (const result of chunkResults) {
            if (result) results.push(result);
        }
        
        // Wait between chunks
        if (i + chunkSize < urls.length) {
            console.log('⏳ Waiting 2 seconds before next chunk...');
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
    
    const withCaptions = results.filter(r => r.success && r.caption);
    console.log(`\n✅ Complete: ${withCaptions.length}/${results.length} captions found`);
    
    return results;
}

module.exports = { getCaptionFromCopytext, processBatch };