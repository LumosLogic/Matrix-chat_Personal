const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = 9002;

console.log('🚀 Starting Admin-Only Proxy Server...');

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', admin_proxy: 'running' });
});

// Serve admin panel directly at root - no conflicts
app.use('/', createProxyMiddleware({
  target: 'http://localhost:8080',
  changeOrigin: true
}));

app.listen(PORT, () => {
  console.log(`✅ Admin-only proxy running on port ${PORT}`);
  console.log(`📋 Admin panel will work perfectly`);
});