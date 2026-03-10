const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = 9001;

console.log('🚀 Starting Reverse Proxy Server...');

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', proxy: 'running' });
});

// Serve admin panel at root - all assets will work
app.use('/', createProxyMiddleware({
  target: 'http://localhost:8080',
  changeOrigin: true,
  onProxyReq: (proxyReq, req, res) => {
    // Add ngrok bypass headers
    proxyReq.setHeader('ngrok-skip-browser-warning', 'true');
  },
  onProxyRes: (proxyRes, req, res) => {
    // Add headers to bypass browser warnings
    proxyRes.headers['ngrok-skip-browser-warning'] = 'true';
  }
}));

app.listen(PORT, () => {
  console.log(`✅ Admin panel served at root - all assets should work`);
  console.log(`📋 Access at: https://franco-saucier-lucie.ngrok-free.dev/`);
});