/**
 * Copytext scraper using Playwright
 */

const { chromium } = require('playwright');
const fs = require('fs');

const COPYTEXT_URL = 'https://copytext.app';

/**
 * Get caption from copytext.app using Playwright
 */
async function getCaptionFromCopytext(reelUrl) {
  console.log(`📝 Fetching caption for: ${reelUrl}`);
  
  let browser;
  let caption = '';
  
  try {
    console.log('🚀 Launching browser on Render...');
    
    // 🔥 FIX: Use Playwright's default browser with proper args for Render
    const launchOptions = { 
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=site-per-process'
      ]
    };
    
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
    
    // Get the caption
    console.log('📝 Extracting caption...');
    
    // Try to get from result area
    try {
      const resultText = await page.evaluate(() => {
        const elements = document.querySelectorAll('div, p, span, section');
        let foundCaption = '';
        
        for (const el of elements) {
          const text = el.textContent || '';
          if (text.includes('Extracted caption') || text.includes('提取的文案')) {
            const parent = el.parentElement;
            if (parent) {
              let cleanText = parent.textContent || '';
              cleanText = cleanText.replace(/Extracted caption|提取的文案/g, '').trim();
              cleanText = cleanText.replace(/Edit|Copy|📋|✏️/g, '').trim();
              if (cleanText.length > 10) {
                return cleanText;
              }
            }
          }
        }
        
        for (const el of elements) {
          const text = el.textContent || '';
          if (text.length > 20 && 
              !text.includes('Paste an Instagram link') &&
              !text.includes('Get text') &&
              !text.includes('copytext') &&
              !text.includes('Cookie') &&
              !text.includes('Language') &&
              !text.includes('History') &&
              !text.includes('Sync') &&
              !text.includes('Sign in') &&
              !text.includes('Edit') &&
              !text.includes('Copy') &&
              !text.includes('提取') &&
              text.length > 15) {
            return text.trim();
          }
        }
        
        return '';
      });
      
      if (resultText) {
        caption = resultText;
        console.log('✅ Found caption in result area');
      }
    } catch (e) {}
    
    // Try clipboard
    if (!caption || caption.length < 10) {
      try {
        const clipboardText = await page.evaluate(() => {
          return navigator.clipboard.readText().catch(() => '');
        });
        
        if (clipboardText && clipboardText.length > 10) {
          caption = clipboardText;
          console.log('✅ Found caption via clipboard');
        }
      } catch (e) {}
    }
    
    // Clean up
    if (caption) {
      const removeTexts = [
        'Edit', 'Copy', '📋', '✏️', 'Get text', 'Extract', 
        'Extracted caption', '提取的文案', '点按以编辑', '编辑',
        'Advertisement', '广告', '复制', '编辑'
      ];
      for (const text of removeTexts) {
        caption = caption.replace(new RegExp(text, 'g'), '');
      }
      caption = caption.trim();
    }
    
    await browser.close();
    
    return {
      caption: caption || '',
      success: caption && caption.length > 5,
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