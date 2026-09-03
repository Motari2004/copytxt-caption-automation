/**
 * Copytext Caption Automation Service
 * Deploy on Render
 */

const express = require('express');
const cors = require('cors');
const { getCaptionFromCopytext, processBatch } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ============== ROUTES ==============

/**
 * Health check endpoint
 */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'Copytext Caption Automation',
    version: '1.0.0',
    uptime: process.uptime()
  });
});

/**
 * Get caption for a single URL
 * POST /api/caption
 * Body: { "url": "https://www.instagram.com/..." }
 */
app.post('/api/caption', async (req, res) => {
  const { url } = req.body;
  
  if (!url) {
    return res.status(400).json({ 
      error: 'Missing url parameter',
      message: 'Please provide an Instagram URL'
    });
  }
  
  try {
    console.log(`📝 Processing URL: ${url}`);
    const result = await getCaptionFromCopytext(url);
    
    if (result.success) {
      res.json({
        success: true,
        url: result.url,
        caption: result.caption,
        length: result.caption.length,
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
    const results = await processBatch(urls);
    
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
    // Try oEmbed first as a faster alternative
    const axios = require('axios');
    const oembedUrl = `https://api.instagram.com/oembed?url=${encodeURIComponent(url)}`;
    const response = await axios.get(oembedUrl, { timeout: 10000 });
    
    if (response.data && response.data.title) {
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
      res.json(result);
    }
  } catch (error) {
    // Fallback to copytext automation
    try {
      const result = await getCaptionFromCopytext(url);
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
      </style>
    </head>
    <body>
      <h1>📝 Copytext Caption Automation</h1>
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
              resultDiv.className = 'result success';
              resultDiv.innerHTML = \`
                <strong>✅ Caption Extracted!</strong>
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
});