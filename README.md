# Copytext Caption Automation

Automate copytext.app to extract Instagram captions.

## Deployment on Render

1. Push this code to GitHub
2. Go to [render.com](https://render.com)
3. Click "New +" → "Web Service"
4. Connect your GitHub repo
5. Set:
   - Name: `copytxt-caption-automation`
   - Environment: `Node`
   - Build Command: `npm install && npx playwright install chromium`
   - Start Command: `npm start`
6. Click "Create Web Service"

## API Endpoints

### GET /api/caption?url=URL
Get caption for a single URL

### POST /api/caption
Body: { "url": "https://..." }

### POST /api/caption/batch
Body: { "urls": ["url1", "url2"] }

## Testing

Visit the homepage for a simple test interface."# copytxt-caption-automation" 
