const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 10000;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Root route: detect mobile
app.get('/', (req, res) => {
  const ua = req.headers['user-agent'] || '';
  if (/Mobi|Android|iPhone|iPad/i.test(ua)) {
    return res.sendFile(path.join(__dirname, 'public', 'mobile.html'));
  }
  return res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Optional: health check for uptime monitoring
app.get('/_health', (req, res) => res.send('ok'));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
