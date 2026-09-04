/**
 * Copytext scraper using Playwright
 */

require('dotenv').config();

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const COPYTEXT_URL = 'https://copytext.app';

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

/**
 * Get caption from copytext.app using Playwright
 */
async function getCaptionFromCopytext(reelUrl) {
  console.log(`📝 Fetching caption for: ${reelUrl}`);
  
  let browser;
  let caption = '';
  
  try {
    const browserPath = getBrowserPath();
    if (browserPath) {
      console.log(`✅ Found browser at: ${browserPath}`);
    }
    
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
    }
    
    console.log('🚀 Launching browser...');
    browser = await chromium.launch(launchOptions);
    
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    });
    
    const page = await context.newPage();
    
    console.log('🌐 Going to copytext.app...');
    await page.goto(COPYTEXT_URL, { 
      waitUntil: 'domcontentloaded', 
      timeout: 30000 
    });
    
    await page.waitForTimeout(3000);
    
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
    await page.waitForTimeout(5000);
    
    console.log('📋 Clicking "Copy"...');
    const copyButton = page.getByRole('button', { name: 'Copy' });
    await copyButton.waitFor({ state: 'visible', timeout: 10000 });
    await copyButton.click();
    
    await page.waitForTimeout(2000);
    
    // 🔥 NEW: Use the exact selector for the caption textbox
    console.log('📝 Extracting caption using exact selector...');
    
    try {
      // Wait for the success state to appear
      await page.waitForSelector('#successState', { timeout: 10000 });
      
      // 🔥 Get the caption from the textbox inside #successState
      const captionTextBox = page.locator('#successState').getByRole('textbox');
      await captionTextBox.waitFor({ state: 'visible', timeout: 5000 });
      
      // Get the text content
      caption = await captionTextBox.textContent();
      
      if (caption && caption.trim().length > 10) {
        caption = caption.trim();
        console.log(`✅ Found caption in #successState textbox: ${caption.substring(0, 50)}...`);
      } else {
        // Try to get the value instead of textContent
        caption = await captionTextBox.inputValue();
        if (caption && caption.trim().length > 10) {
          caption = caption.trim();
          console.log(`✅ Found caption via inputValue: ${caption.substring(0, 50)}...`);
        }
      }
    } catch (e) {
      console.log('⚠️ Could not find #successState textbox, trying fallback...');
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
          
          // Look for large text blocks
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
    
    // Clean up
    if (caption) {
      // Remove common UI text
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
    
    await browser.close();
    
    console.log(`📊 Final caption length: ${caption ? caption.length : 0} characters`);
    
    return {
      caption: caption || '',
      success: caption && caption.length > 20,
      url: reelUrl
    };
    
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    if (browser) {
      await browser.close();
    }
    return {
      caption: '',
      success: false,
      error: error.message,
      url: reelUrl
    };
  }
}

/**
 * Process multiple URLs
 */
async function processBatch(urls) {
  const results = [];
  
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i].trim();
    if (!url) continue;
    
    console.log(`\n[${i + 1}/${urls.length}] Processing...`);
    const result = await getCaptionFromCopytext(url);
    results.push({
      url: result.url,
      caption: result.caption || '',
      success: result.success,
      timestamp: new Date().toISOString()
    });
    
    if (i < urls.length - 1) {
      console.log('⏳ Waiting 2 seconds...');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  
  return results;
}

module.exports = { getCaptionFromCopytext, processBatch };