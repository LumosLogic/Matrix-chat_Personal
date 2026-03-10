const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = 9001;

console.log('🚀 Starting Reverse Proxy Server...');

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', proxy: 'running' });
});

// Admin panel - handle all admin routes and assets
app.use('/admin', createProxyMiddleware({
  target: 'http://localhost:8080',
  changeOrigin: true,
  pathRewrite: { '^/admin': '' },
  logLevel: 'debug'
}));

// Static assets for admin (CSS, JS, images)
app.use('/static', createProxyMiddleware({
  target: 'http://localhost:8080',
  changeOrigin: true
}));

app.use('/assets', createProxyMiddleware({
  target: 'http://localhost:8080',
  changeOrigin: true
}));

// API routes
app.use('/api', createProxyMiddleware({
  target: 'http://localhost:3000',
  changeOrigin: true
}));

app.use('/register', createProxyMiddleware({
  target: 'http://localhost:3000',
  changeOrigin: true
}));

app.use('/location', createProxyMiddleware({
  target: 'http://localhost:3000',
  changeOrigin: true
}));

app.use('/.well-known', createProxyMiddleware({
  target: 'http://localhost:3000',
  changeOrigin: true
}));

// Matrix Synapse - ALL other traffic
app.use('/', createProxyMiddleware({
  target: 'http://localhost:8008',
  changeOrigin: true,
  ws: true
}));

app.listen(PORT, () => {
  console.log(`✅ Reverse proxy running on port ${PORT}`);
  console.log(`📋 All routes configured with admin asset support`);
});